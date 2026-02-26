import * as eks from 'aws-cdk-lib/aws-eks';
import { Construct } from 'constructs';

export interface EksServiceProps {
  cluster: eks.ICluster;
  serviceName: string;
  image: string;
  containerPort?: number;
  healthCheckPath?: string;
  healthCheckPort?: number;
  env: { [key: string]: string };
  minReplicas?: number;
  maxReplicas?: number;
  cpuRequest?: string;
  memoryRequest?: string;
  cpuLimit?: string;
  memoryLimit?: string;
  serviceAccountName: string;
  isPublic?: boolean;
  publicPort?: number;
}

export class EksService extends Construct {
  constructor(scope: Construct, id: string, props: EksServiceProps) {
    super(scope, id);

    const appLabels = { app: props.serviceName };
    const minReplicas = props.minReplicas ?? 2;
    const maxReplicas = props.maxReplicas ?? 10;

    const containerEnv = Object.entries(props.env).map(([name, value]) => ({ name, value }));

    const adotSidecar = {
      name: 'adot-collector',
      image: 'amazon/aws-otel-collector:latest',
      command: ['--config=/etc/otel-collector-config.yaml'],
      resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '200m', memory: '256Mi' } },
    };

    const mainContainer: any = {
      name: props.serviceName,
      image: props.image,
      env: containerEnv,
      resources: {
        requests: { cpu: props.cpuRequest ?? '250m', memory: props.memoryRequest ?? '512Mi' },
        limits: { cpu: props.cpuLimit ?? '500m', memory: props.memoryLimit ?? '1Gi' },
      },
    };

    if (props.containerPort) {
      mainContainer.ports = [{ containerPort: props.containerPort }];
    }

    if (props.healthCheckPath && props.healthCheckPort) {
      mainContainer.livenessProbe = {
        httpGet: { path: props.healthCheckPath, port: props.healthCheckPort },
        initialDelaySeconds: 30,
        periodSeconds: 15,
      };
      mainContainer.readinessProbe = {
        httpGet: { path: props.healthCheckPath, port: props.healthCheckPort },
        initialDelaySeconds: 5,
        periodSeconds: 10,
      };
    }

    // 1. Deployment
    props.cluster.addManifest(`${id}Deployment`, {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: props.serviceName, namespace: 'default' },
      spec: {
        replicas: minReplicas,
        selector: { matchLabels: appLabels },
        template: {
          metadata: { labels: appLabels },
          spec: {
            serviceAccountName: props.serviceAccountName,
            containers: [mainContainer, adotSidecar],
          },
        },
      },
    });

    // 2. HPA
    props.cluster.addManifest(`${id}HPA`, {
      apiVersion: 'autoscaling/v2',
      kind: 'HorizontalPodAutoscaler',
      metadata: { name: `${props.serviceName}-hpa`, namespace: 'default' },
      spec: {
        scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: props.serviceName },
        minReplicas: minReplicas,
        maxReplicas: maxReplicas,
        metrics: [{ type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 70 } } }],
      },
    });

    // 3. Optional Public Load Balancer
    if (props.isPublic && props.containerPort) {
      props.cluster.addManifest(`${id}Service`, {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: {
          name: `${props.serviceName}-lb`,
          namespace: 'default',
          annotations: {
            'service.beta.kubernetes.io/aws-load-balancer-type': 'external',
            'service.beta.kubernetes.io/aws-load-balancer-nlb-target-type': 'ip',
            'service.beta.kubernetes.io/aws-load-balancer-scheme': 'internet-facing',
          },
        },
        spec: {
          type: 'LoadBalancer',
          selector: appLabels,
          ports: [{ protocol: 'TCP', port: props.publicPort ?? 80, targetPort: props.containerPort }],
        },
      });
    }
  }
}
