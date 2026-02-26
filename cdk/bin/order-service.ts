#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { OrderServiceStack } from '../lib/order-service-stack';

const app = new cdk.App();
new OrderServiceStack(app, 'OrderServiceStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
