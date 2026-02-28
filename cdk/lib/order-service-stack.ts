import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as redshiftserverless from 'aws-cdk-lib/aws-redshiftserverless';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
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

    // 2. Aurora PostgreSQL Cluster (Writer & Reader)
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

    // 3. ElastiCache Redis (for Read Service)
    const redisSubnetGroup = new elasticache.CfnSubnetGroup(this, 'RedisSubnetGroup', {
      description: 'Subnet group for Redis',
      subnetIds: vpc.privateSubnets.map(s => s.subnetId),
    });

    const redisSecurityGroup = new ec2.SecurityGroup(this, 'RedisSG', { vpc });
    
    const redisCluster = new elasticache.CfnCacheCluster(this, 'OrderCache', {
      cacheNodeType: 'cache.t3.micro',
      engine: 'redis',
      numCacheNodes: 1,
      cacheSubnetGroupName: redisSubnetGroup.ref,
      vpcSecurityGroupIds: [redisSecurityGroup.securityGroupId],
    });

    // 4. Redshift Serverless (Business Analytics)
    const redshiftNamespace = new redshiftserverless.CfnNamespace(this, 'AnalyticsNamespace', {
      namespaceName: 'order-analytics',
      adminUsername: 'admin',
      adminUserPassword: cdk.SecretValue.unsafePlainText('TemporaryPassword123!').toString(), // Should use Secrets Manager in prod
    });

    const redshiftWorkgroup = new redshiftserverless.CfnWorkgroup(this, 'AnalyticsWorkgroup', {
      workgroupName: 'order-analytics-workgroup',
      namespaceName: redshiftNamespace.namespaceName,
      subnetIds: vpc.privateSubnets.map(s => s.subnetId),
      securityGroupIds: [new ec2.SecurityGroup(this, 'RedshiftSG', { vpc }).securityGroupId],
      publiclyAccessible: false,
    });

    // 5. EKS Cluster
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

    dbCluster.connections.allowFrom(cluster.clusterSecurityGroup, ec2.Port.tcp(5432));
    redisSecurityGroup.addIngressRule(cluster.clusterSecurityGroup, ec2.Port.tcp(6379));

    // 6. SQS Queues
    const orderQueue = new sqs.Queue(this, 'OrderQueue', {
      visibilityTimeout: cdk.Duration.seconds(30),
    });

    const notificationQueue = new sqs.Queue(this, 'NotificationQueue', {
      visibilityTimeout: cdk.Duration.seconds(30),
    });

    // 7. IAM Roles for Service Accounts (IRSA)
    const writeSvcSA = cluster.addServiceAccount('WriteServiceSA', { name: 'write-service-sa', namespace: 'default' });
    const readSvcSA = cluster.addServiceAccount('ReadServiceSA', { name: 'read-service-sa', namespace: 'default' });
    const procSvcSA = cluster.addServiceAccount('ProcessorServiceSA', { name: 'processor-service-sa', namespace: 'default' });
    const notifSvcSA = cluster.addServiceAccount('NotificationServiceSA', { name: 'notification-service-sa', namespace: 'default' });

    if (dbCluster.secret) {
      dbCluster.secret.grantRead(writeSvcSA.role);
      dbCluster.secret.grantRead(readSvcSA.role);
      dbCluster.secret.grantRead(procSvcSA.role);
    }

    orderQueue.grantSendMessages(writeSvcSA.role);
    orderQueue.grantConsumeMessages(procSvcSA.role);
    notificationQueue.grantSendMessages(procSvcSA.role);
    notificationQueue.grantConsumeMessages(notifSvcSA.role);

    // SES Permission for Notification Service
    notifSvcSA.role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSESFullAccess'));

    // 8. Application Services
    const commonEnv = {
      DB_SECRET_ARN: dbCluster.secret?.secretArn || '',
      DB_WRITER_ENDPOINT: dbCluster.clusterEndpoint.hostname,
      DB_READER_ENDPOINT: dbCluster.clusterReadEndpoint.hostname,
      AWS_REGION: this.region,
    };

    // WRITE SERVICE
    new EksService(this, 'WriteService', {
      cluster,
      serviceName: 'write-service',
      image: 'amazon/amazon-ecs-sample',
      containerPort: 3000,
      healthCheckPath: '/health',
      env: { ...commonEnv, ORDER_QUEUE_URL: orderQueue.queueUrl },
      serviceAccountName: writeSvcSA.serviceAccountName,
      isPublic: true,
    });

    // READ SERVICE
    new EksService(this, 'ReadService', {
      cluster,
      serviceName: 'read-service',
      image: 'amazon/amazon-ecs-sample',
      containerPort: 3001,
      healthCheckPath: '/health',
      env: { ...commonEnv, REDIS_ENDPOINT: redisCluster.attrRedisEndpointAddress },
      serviceAccountName: readSvcSA.serviceAccountName,
      isPublic: true,
    });

    // PROCESSOR SERVICE
    new EksService(this, 'ProcessorService', {
      cluster,
      serviceName: 'processor-service',
      image: 'amazon/amazon-ecs-sample',
      containerPort: 3002,
      healthCheckPath: '/health',
      env: { ...commonEnv, ORDER_QUEUE_URL: orderQueue.queueUrl, NOTIFICATION_QUEUE_URL: notificationQueue.queueUrl },
      serviceAccountName: procSvcSA.serviceAccountName,
      isPublic: false,
    });

    // NOTIFICATION SERVICE
    new EksService(this, 'NotificationService', {
      cluster,
      serviceName: 'notification-service',
      image: 'amazon/amazon-ecs-sample',
      containerPort: 3003,
      healthCheckPath: '/health',
      env: { ...commonEnv, NOTIFICATION_QUEUE_URL: notificationQueue.queueUrl },
      serviceAccountName: notifSvcSA.serviceAccountName,
      isPublic: false,
    });

    // 9. API Gateway (Frontend for the System)
    const api = new apigateway.RestApi(this, 'OrderApi', {
      restApiName: 'Order Service API',
      description: 'Gateway for Order Processing System',
    });
    // In a real scenario, we would link this to the ALB or use VPC Link

    // 10. CloudWatch Dashboard
    const dashboard = new cloudwatch.Dashboard(this, 'OrderServiceDashboard', {
      dashboardName: 'OrderProcessingSystem',
    });

    dashboard.addWidgets(
      new cloudwatch.TextWidget({ markdown: '# Order Processing System Metrics', width: 24, height: 2 }),
      new cloudwatch.GraphWidget({
        title: 'SQS Queue Depth',
        left: [
          orderQueue.metricApproximateNumberOfMessagesVisible({ label: 'Order Queue' }),
          notificationQueue.metricApproximateNumberOfMessagesVisible({ label: 'Notification Queue' }),
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
