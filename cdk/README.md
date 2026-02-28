# CDK Infrastructure

This directory contains the AWS CDK (Cloud Development Kit) code to deploy the **Order Processing System** on AWS using TypeScript.

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
    
4.  **Visualize Cloudformation Template:**
    ```bash
    npx cdk-dia
    ```
    This generates a [dot diagram](diagram.dot) and [preview image](diagram.png)


4.  **Deploy the Stack:**
    ```bash
    npx cdk deploy
    ```

## Useful Commands

- `npm run build` - Compile TypeScript to JavaScript.
- `npx cdk diff` - Compare the current state of the stack with the deployed version.
- `npx cdk destroy` - Delete the deployed stack.
