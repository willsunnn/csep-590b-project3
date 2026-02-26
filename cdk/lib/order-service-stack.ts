import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as eventbridge from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { KubectlV28Layer } from '@aws-cdk/lambda-layer-kubectl-v28';

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

    // 6. Kubernetes Manifests
    const appEnv = [
      { name: 'DB_SECRET_ARN', value: dbCluster.secret?.secretArn || '' },
      { name: 'DB_WRITER_ENDPOINT', value: dbCluster.clusterEndpoint.hostname },
      { name: 'DB_READER_ENDPOINT', value: dbCluster.clusterReadEndpoint.hostname },
      { name: 'EVENT_BUS_NAME', value: eventBus.eventBusName },
      { name: 'STOCK_VALIDATION_QUEUE_URL', value: stockValidationQueue.queueUrl },
      { name: 'INVENTORY_UPDATE_QUEUE_URL', value: inventoryUpdateQueue.queueUrl },
      { name: 'AWS_REGION', value: cdk.Stack.of(this).region },
    ];

    // API WRITE SERVICE
    cluster.addManifest('ApiWriteDeployment', {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'api-write-service', namespace: 'default' },
      spec: {
        replicas: 2,
        selector: { matchLabels: { app: 'api-write-service' } },
        template: {
          metadata: { labels: { app: 'api-write-service' } },
          spec: {
            serviceAccountName: serviceAccount.serviceAccountName,
            containers: [{
              name: 'api-write',
              image: 'amazon/amazon-ecs-sample',
              ports: [{ containerPort: 3000 }],
              env: appEnv,
              resources: { requests: { cpu: '250m', memory: '512Mi' }, limits: { cpu: '500m', memory: '1Gi' } },
              livenessProbe: {
                httpGet: { path: '/health/deep', port: 3000 },
                initialDelaySeconds: 30,
                periodSeconds: 15,
              },
              readinessProbe: {
                httpGet: { path: '/health/deep', port: 3000 },
                initialDelaySeconds: 5,
                periodSeconds: 10,
              },
            }],
          },
        },
      },
    });

    cluster.addManifest('ApiWriteLB', {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { 
        name: 'api-write-service-lb', 
        namespace: 'default',
        annotations: {
          'service.beta.kubernetes.io/aws-load-balancer-type': 'external',
          'service.beta.kubernetes.io/aws-load-balancer-nlb-target-type': 'ip',
          'service.beta.kubernetes.io/aws-load-balancer-scheme': 'internet-facing'
        }
      },
      spec: { type: 'LoadBalancer', selector: { app: 'api-write-service' }, ports: [{ protocol: 'TCP', port: 80, targetPort: 3000 }] },
    });

    // API READ SERVICE
    cluster.addManifest('ApiReadDeployment', {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'api-read-service', namespace: 'default' },
      spec: {
        replicas: 2,
        selector: { matchLabels: { app: 'api-read-service' } },
        template: {
          metadata: { labels: { app: 'api-read-service' } },
          spec: {
            serviceAccountName: serviceAccount.serviceAccountName,
            containers: [{
              name: 'api-read',
              image: 'amazon/amazon-ecs-sample',
              ports: [{ containerPort: 3001 }],
              env: appEnv,
              resources: { requests: { cpu: '250m', memory: '512Mi' }, limits: { cpu: '500m', memory: '1Gi' } },
              livenessProbe: {
                httpGet: { path: '/health/deep', port: 3001 },
                initialDelaySeconds: 30,
                periodSeconds: 15,
              },
              readinessProbe: {
                httpGet: { path: '/health/deep', port: 3001 },
                initialDelaySeconds: 5,
                periodSeconds: 10,
              },
            }],
          },
        },
      },
    });

    cluster.addManifest('ApiReadLB', {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { 
        name: 'api-read-service-lb', 
        namespace: 'default',
        annotations: {
          'service.beta.kubernetes.io/aws-load-balancer-type': 'external',
          'service.beta.kubernetes.io/aws-load-balancer-nlb-target-type': 'ip',
          'service.beta.kubernetes.io/aws-load-balancer-scheme': 'internet-facing'
        }
      },
      spec: { type: 'LoadBalancer', selector: { app: 'api-read-service' }, ports: [{ protocol: 'TCP', port: 80, targetPort: 3001 }] },
    });

    // WORKER SERVICE
    cluster.addManifest('WorkerServiceDeployment', {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'worker-service', namespace: 'default' },
      spec: {
        replicas: 2,
        selector: { matchLabels: { app: 'worker-service' } },
        template: {
          metadata: { labels: { app: 'worker-service' } },
          spec: {
            serviceAccountName: serviceAccount.serviceAccountName,
            containers: [{
              name: 'worker',
              image: 'amazon/amazon-ecs-sample',
              env: appEnv,
              resources: { requests: { cpu: '250m', memory: '512Mi' }, limits: { cpu: '500m', memory: '1Gi' } },
              livenessProbe: {
                httpGet: { path: '/health/deep', port: 3002 },
                initialDelaySeconds: 30,
                periodSeconds: 15,
              },
              readinessProbe: {
                httpGet: { path: '/health/deep', port: 3002 },
                initialDelaySeconds: 5,
                periodSeconds: 10,
              },
            }],
          },
        },
      },
    });

    // HPAs
    cluster.addManifest('ApiWriteHPA', {
      apiVersion: 'autoscaling/v2',
      kind: 'HorizontalPodAutoscaler',
      metadata: { name: 'api-write-hpa', namespace: 'default' },
      spec: { scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'api-write-service' }, minReplicas: 2, maxReplicas: 10, metrics: [{ type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 70 } } }] },
    });

    cluster.addManifest('ApiReadHPA', {
      apiVersion: 'autoscaling/v2',
      kind: 'HorizontalPodAutoscaler',
      metadata: { name: 'api-read-hpa', namespace: 'default' },
      spec: { scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'api-read-service' }, minReplicas: 2, maxReplicas: 20, metrics: [{ type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 70 } } }] },
    });
  }
}
