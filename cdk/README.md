# CDK Infrastructure

This directory contains the AWS CDK (Cloud Development Kit) code to deploy the **Order Processing System** on AWS using TypeScript.

## Infrastructure Components

- **VPC:** Custom VPC with 2 Availability Zones and NAT Gateway for private subnet connectivity.
- **EKS Cluster:** Managed Kubernetes cluster (v1.28) with node groups and Load Balancer controller.
- **Aurora PostgreSQL:** Serverless v2 cluster with Writer and Reader endpoints.
- **EventBridge Bus:** Central event bus for service communication.
- **SQS Queues:** Buffering queues for event-driven workers.
- **IAM (IRSA):** Least-privileged IAM roles mapped to Kubernetes service accounts.

## Prerequisites

- [Node.js](https://nodejs.org/) (v20+)
- [AWS CLI](https://aws.amazon.com/cli/) configured with proper credentials.
- [AWS CDK CLI](https://docs.aws.amazon.com/cdk/v2/guide/getting_started.html) (`npm install -g aws-cdk`)

## Getting Started

1.  **Install Dependencies:**
    ```bash
    cd cdk
    npm install
    ```

2.  **Bootstrap CDK (if not already done in the target account/region):**
    ```bash
    npx cdk bootstrap
    ```

3.  **Synthesize CloudFormation Template:**
    ```bash
    npx cdk synth
    ```

4.  **Deploy the Stack:**
    ```bash
    npx cdk deploy
    ```

## Useful Commands

- `npm run build` - Compile TypeScript to JavaScript.
- `npx cdk diff` - Compare the current state of the stack with the deployed version.
- `npx cdk destroy` - Delete the deployed stack.
