import express from 'express';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { v4 as uuidv4 } from 'uuid';
import { getWriterPool } from '../shared/db';
import { Order } from '../shared/types';

const app = express();
app.use(express.json());

const ebClient = new EventBridgeClient({});
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME || 'OrderEventBus';
const PORT = process.env.PORT || 3000;

app.post('/orders', async (req, res): Promise<void> => {
  try {
    const body = req.body;
    if (!body.customerId || !body.items || !Array.isArray(body.items)) {
      res.status(400).json({ message: 'Missing customerId or items' });
      return;
    }

    const order: Order = {
      id: uuidv4(),
      customerId: body.customerId,
      items: body.items,
      status: 'PENDING',
      createdAt: new Date().toISOString(),
    };

    const pool = await getWriterPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await client.query(
        'INSERT INTO orders (id, customer_id, status, created_at) VALUES ($1, $2, $3, $4)',
        [order.id, order.customerId, order.status, order.createdAt]
      );
      for (const item of order.items) {
        await client.query(
          'INSERT INTO order_items (order_id, product_id, quantity) VALUES ($1, $2, $3)',
          [order.id, item.productId, item.quantity]
        );
      }
      await client.query('COMMIT');
    } catch (dbError) {
      await client.query('ROLLBACK');
      throw dbError;
    } finally {
      client.release();
    }

    await ebClient.send(new PutEventsCommand({
      Entries: [{
        Source: 'com.retailer.orders',
        DetailType: 'OrderCreated',
        Detail: JSON.stringify(order),
        EventBusName: EVENT_BUS_NAME,
      }],
    }));

    res.status(201).json({ orderId: order.id, status: 'ACCEPTED' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});

app.get('/health', (req, res) => res.status(200).send('OK'));

app.get('/health/deep', async (req, res) => {
  try {
    const pool = await getWriterPool();
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'HEALTHY', database: 'CONNECTED' });
  } catch (err) {
    console.error('Deep health check failed:', err);
    res.status(500).json({ status: 'UNHEALTHY', database: 'DISCONNECTED' });
  }
});

app.listen(PORT, () => console.log(`API Write Service listening on port ${PORT}`));
