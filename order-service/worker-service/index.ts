import { Consumer } from 'sqs-consumer';
import { SQSClient } from '@aws-sdk/client-sqs';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { Order } from '../shared/types';
import { getReaderPool, getWriterPool } from '../shared/db';
import express from 'express';

const app = express();
const HEALTH_PORT = process.env.HEALTH_PORT || 3002;

app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/health/deep', async (req, res) => {
  try {
    const pool = await getReaderPool();
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'HEALTHY', database: 'CONNECTED' });
  } catch (err) {
    console.error('Deep health check failed:', err);
    res.status(500).json({ status: 'UNHEALTHY', database: 'DISCONNECTED' });
  }
});

app.listen(HEALTH_PORT, () => console.log(`Worker Health Check listening on port ${HEALTH_PORT}`));

const sqsClient = new SQSClient({});
const ebClient = new EventBridgeClient({});

const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME || 'OrderEventBus';

// Consumer 1: Stock Validation
const stockValidationApp = Consumer.create({
  queueUrl: process.env.STOCK_VALIDATION_QUEUE_URL!,
  sqs: sqsClient,
  handleMessage: async (message): Promise<any> => {
    if (!message.Body) return message;
    const body = JSON.parse(message.Body);
    const order: Order = JSON.parse(body.detail);

    let isStockAvailable = true;
    const readerPool = await getReaderPool();

    for (const item of order.items) {
      const res = await readerPool.query(
        'SELECT stock FROM inventory WHERE product_id = $1',
        [item.productId]
      );
      if (res.rows.length === 0 || res.rows[0].stock < item.quantity) {
        isStockAvailable = false;
        break;
      }
    }

    const newStatus = isStockAvailable ? 'STOCK_VALIDATED' : 'FAILED';

    const writerPool = await getWriterPool();
    await writerPool.query(
      'UPDATE orders SET status = $1 WHERE id = $2',
      [newStatus, order.id]
    );

    await ebClient.send(new PutEventsCommand({
      Entries: [{
        Source: 'com.retailer.orders',
        DetailType: isStockAvailable ? 'StockValidated' : 'StockValidationFailed',
        Detail: JSON.stringify({ ...order, status: newStatus }),
        EventBusName: EVENT_BUS_NAME,
      }],
    }));

    return message;
  }
});

// Consumer 2: Inventory Update
const inventoryUpdateApp = Consumer.create({
  queueUrl: process.env.INVENTORY_UPDATE_QUEUE_URL!,
  sqs: sqsClient,
  handleMessage: async (message): Promise<any> => {
    if (!message.Body) return message;
    const body = JSON.parse(message.Body);
    const order: Order = JSON.parse(body.detail);

    const writerPool = await getWriterPool();
    const client = await writerPool.connect();

    try {
      await client.query('BEGIN');
      for (const item of order.items) {
        await client.query(
          'UPDATE inventory SET stock = stock - $1 WHERE product_id = $2',
          [item.quantity, item.productId]
        );
      }
      const newStatus = 'INVENTORY_UPDATED';
      await client.query('UPDATE orders SET status = $1 WHERE id = $2', [newStatus, order.id]);
      await client.query('COMMIT');

      await ebClient.send(new PutEventsCommand({
        Entries: [{
          Source: 'com.retailer.orders',
          DetailType: 'InventoryUpdated',
          Detail: JSON.stringify({ ...order, status: newStatus }),
          EventBusName: EVENT_BUS_NAME,
        }],
      }));
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return message;
  }
});

stockValidationApp.on('error', (err) => console.error('Stock Validation Error:', err.message));
inventoryUpdateApp.on('error', (err) => console.error('Inventory Update Error:', err.message));

stockValidationApp.start();
inventoryUpdateApp.start();

console.log('Worker Service is listening for messages...');
