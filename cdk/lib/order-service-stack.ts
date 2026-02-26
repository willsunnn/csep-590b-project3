import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as eventbridge from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { KubectlV28Layer } from '@aws-cdk/lambda-layer-kubectl-v28';
import { EksService } from './eks-service';

export class OrderServiceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 1. VPC
    const vpc = new ec2.Vpc(this, 'OrderServiceVpc', {
      maxAzs: 2,
      natGateways: 1,
    });

    // 2. Aurora PostgreSQL Cluster
    const dbCluster = new rds.DatabaseCluster(this, 'OrderDatabase', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_15_3,
      }),
      writer: rds.ClusterInstance.serverlessV2('Writer'),
      readers: [
        rds.ClusterInstance.serverlessV2('Reader1', { scaleWithWriter: true }),
      ],
      vpc,
      serverlessV2MinCapacity: 0.5,
      serverlessV2MaxCapacity: 2,
      defaultDatabaseName: 'retail',
    });

    // 3. EKS Cluster
    const cluster = new eks.Cluster(this, 'OrderServiceCluster', {
      vpc,
      version: eks.KubernetesVersion.V1_28,
      kubectlLayer: new KubectlV28Layer(this, 'kubectl'),
      defaultCapacity: 2,
      defaultCapacityInstance: ec2.InstanceType.of(ec2.InstanceClass.M5, ec2.InstanceSize.LARGE),
      albController: {
        version: eks.AlbControllerVersion.V2_6_2,
      },
    });

    // Enable Container Insights
    new eks.HelmChart(this, 'CloudWatchContainerInsights', {
      cluster,
      chart: 'aws-cloudwatch-metrics',
      repository: 'https://aws.github.io/eks-charts',
      namespace: 'amazon-cloudwatch',
      createNamespace: true,
      values: {
        clusterName: cluster.clusterName,
        region: this.region,
      }
    });

    dbCluster.connections.allowFrom(cluster.clusterSecurityGroup, ec2.Port.tcp(5432));

    // 4. EventBridge and SQS
    const eventBus = new eventbridge.EventBus(this, 'OrderEventBus', {
      eventBusName: 'OrderEventBus',
    });

    const stockValidationQueue = new sqs.Queue(this, 'StockValidationQueue', {
      visibilityTimeout: cdk.Duration.seconds(30),
    });
    new eventbridge.Rule(this, 'OrderCreatedRule', {
      eventBus: eventBus,
      eventPattern: { source: ['com.retailer.orders'], detailType: ['OrderCreated'] },
      targets: [new targets.SqsQueue(stockValidationQueue)],
    });

    const inventoryUpdateQueue = new sqs.Queue(this, 'InventoryUpdateQueue', {
      visibilityTimeout: cdk.Duration.seconds(30),
    });
    new eventbridge.Rule(this, 'StockValidatedRule', {
      eventBus: eventBus,
      eventPattern: { source: ['com.retailer.orders'], detailType: ['StockValidated'] },
      targets: [new targets.SqsQueue(inventoryUpdateQueue)],
    });

    // 5. IAM Roles for Service Accounts (IRSA)
    const serviceAccount = cluster.addServiceAccount('OrderServiceAppAccount', {
      name: 'order-service-sa',
      namespace: 'default',
    });

    if (dbCluster.secret) {
      dbCluster.secret.grantRead(serviceAccount.role);
    }
    eventBus.grantPutEventsTo(serviceAccount.role);
    stockValidationQueue.grantConsumeMessages(serviceAccount.role);
    inventoryUpdateQueue.grantConsumeMessages(serviceAccount.role);
    serviceAccount.role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'));

    // 6. Application Services using common construct
    const commonEnv = {
      DB_SECRET_ARN: dbCluster.secret?.secretArn || '',
      DB_WRITER_ENDPOINT: dbCluster.clusterEndpoint.hostname,
      DB_READER_ENDPOINT: dbCluster.clusterReadEndpoint.hostname,
      EVENT_BUS_NAME: eventBus.eventBusName,
      STOCK_VALIDATION_QUEUE_URL: stockValidationQueue.queueUrl,
      INVENTORY_UPDATE_QUEUE_URL: inventoryUpdateQueue.queueUrl,
      AWS_REGION: this.region,
    };

    // API WRITE SERVICE
    new EksService(this, 'ApiWriteService', {
      cluster,
      serviceName: 'api-write-service',
      image: 'amazon/amazon-ecs-sample',
      containerPort: 3000,
      healthCheckPath: '/health/deep',
      healthCheckPort: 3000,
      env: commonEnv,
      minReplicas: 2,
      maxReplicas: 10,
      serviceAccountName: serviceAccount.serviceAccountName,
      isPublic: true,
    });

    // API READ SERVICE
    new EksService(this, 'ApiReadService', {
      cluster,
      serviceName: 'api-read-service',
      image: 'amazon/amazon-ecs-sample',
      containerPort: 3001,
      healthCheckPath: '/health/deep',
      healthCheckPort: 3001,
      env: commonEnv,
      minReplicas: 2,
      maxReplicas: 20,
      serviceAccountName: serviceAccount.serviceAccountName,
      isPublic: true,
    });

    // WORKER SERVICE
    new EksService(this, 'WorkerService', {
      cluster,
      serviceName: 'worker-service',
      image: 'amazon/amazon-ecs-sample',
      containerPort: 3002, // Health check port
      healthCheckPath: '/health/deep',
      healthCheckPort: 3002,
      env: commonEnv,
      minReplicas: 2,
      maxReplicas: 20,
      serviceAccountName: serviceAccount.serviceAccountName,
      isPublic: false,
    });

    // 7. CloudWatch Dashboard
    const dashboard = new cloudwatch.Dashboard(this, 'OrderServiceDashboard', {
      dashboardName: 'OrderProcessingSystem',
    });

    dashboard.addWidgets(
      new cloudwatch.TextWidget({ markdown: '# Order Processing System Metrics', width: 24, height: 2 })
    );

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'SQS Queue Depth',
        left: [
          stockValidationQueue.metricApproximateNumberOfMessagesVisible({ label: 'Stock Validation' }),
          inventoryUpdateQueue.metricApproximateNumberOfMessagesVisible({ label: 'Inventory Update' }),
        ],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Database CPU Utilization',
        left: [dbCluster.metricCPUUtilization()],
        width: 12,
      })
    );
  }
}
