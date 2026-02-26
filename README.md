# Event-Driven Inventory & Order Processing System

A high-performance, scalable cloud application designed for a mid-size retailer. This project demonstrates an event-driven architecture using **Amazon EKS (Kubernetes)** and **Amazon Aurora PostgreSQL**, implementing the **CQRS (Command Query Responsibility Segregation)** pattern.

## Architecture Overview

- **Event-Driven:** Uses **Amazon EventBridge** as the central event bus for decoupling services.
- **Asynchronous Workflows:** Employs **Amazon SQS** as a buffer between events and background workers to handle unpredictable traffic spikes.
- **CQRS Implementation:**
  - **Write Side (Commands):** `api-write-service` handles order intake and writes to the primary database instance.
  - **Read Side (Queries):** `api-read-service` handles status lookups and queries from read replicas.
- **Scalability:** Both API and Worker services are containerized and autoscale via Kubernetes **Horizontal Pod Autoscalers (HPA)**.
- **Resilience:** Aurora PostgreSQL Serverless v2 provides automated failover and multi-AZ support.

## Project Structure

```text
.
├── cdk/                    # Infrastructure as Code (AWS CDK)
│   ├── bin/                # CDK entry point
│   ├── lib/                # Infrastructure stack definition (VPC, EKS, RDS, etc.)
│   └── test/               # CDK infrastructure tests
├── order-service/          # Application source code
│   ├── api-write-service/  # Command service (PostgreSQL Writer)
│   ├── api-read-service/   # Query service (PostgreSQL Reader)
│   ├── worker-service/     # Background event processor (Stock & Inventory)
│   ├── shared/             # Common DB pools and TypeScript types
│   └── scripts/            # Load testing and utility scripts
└── .gitignore              # Project-wide git exclusions
```

## Core Workflows

1. **Order Intake:** `api-write-service` (POST /orders) -> Aurora (Primary) -> EventBridge (`OrderCreated`).
2. **Stock Validation:** `OrderCreated` -> SQS -> `worker-service` -> Aurora (Replica) -> EventBridge (`StockValidated`).
3. **Inventory Update:** `StockValidated` -> SQS -> `worker-service` -> Aurora (Primary) -> EventBridge (`InventoryUpdated`).
4. **Analytics/Notifications:** Handlers consume `InventoryUpdated` events for secondary operations.
