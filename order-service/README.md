# Application Services (order-service)

This directory contains the containerized TypeScript services for order processing. Each service is built to be deployed on **Amazon EKS (Kubernetes)** and interacts with an **Amazon Aurora PostgreSQL** cluster.

## Services Details

### API Write Service (`api-write-service`)
- **Port:** 3000
- **Responsibility:** Handles Command operations (POST requests to create orders).
- **Database:** Connects to the **Aurora Writer Endpoint**.
- **Events:** Publishes `OrderCreated` to EventBridge.

### API Read Service (`api-read-service`)
- **Port:** 3001
- **Responsibility:** Handles Query operations (GET requests to fetch order status).
- **Database:** Connects to the **Aurora Reader Endpoint** (Replica).
- **Scaling:** Optimized for read-heavy traffic with independent HPA.

### Worker Service (`worker-service`)
- **Responsibility:** Asynchronous background processing.
- **Components:**
  - **Stock Validation:** Polls SQS (`OrderCreated`) and validates stock against the reader replica.
  - **Inventory Update:** Polls SQS (`StockValidated`) and deducts stock from the writer instance.
- **Events:** Publishes `StockValidated` or `InventoryUpdated` to EventBridge.

### Shared Logic (`shared/`)
- Contains database connection pooling and central TypeScript types used across all services.

## Development and Running

### Prerequisites
- Node.js (v20+)
- TypeScript (`npm install -g typescript`)

### Getting Started

1.  **Install Dependencies:**
    ```bash
    cd order-service
    npm install
    ```

2.  **Build the Services:**
    ```bash
    npm run build
    ```

## Local Development (Testing)

Each service expects the following environment variables (automatically injected by Kubernetes in EKS):
- `DB_SECRET_ARN`: ARN of the database secret in AWS Secrets Manager.
- `DB_WRITER_ENDPOINT`: Hostname for the primary database.
- `DB_READER_ENDPOINT`: Hostname for the reader replica.
- `EVENT_BUS_NAME`: Name of the EventBridge bus.

## Running Load Tests
A synthetic load test script is included to simulate high-traffic events:
```bash
cd order-service
npx ts-node scripts/load-test.ts
```
*(Requires `API_URL` environment variable pointing to the deployed NLB endpoint)*
