import express from 'express';
import { getReaderPool } from '../shared/db';

const app = express();
const PORT = process.env.PORT || 3001;

app.get('/orders/:id', async (req, res): Promise<void> => {
  try {
    const { id } = req.params;
    const pool = await getReaderPool();
    const result = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
    
    if (result.rows.length === 0) {
      res.status(404).json({ message: 'Order not found' });
      return;
    }

    const orderItemsResult = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [id]);
    const order = {
      ...result.rows[0],
      items: orderItemsResult.rows,
    };

    res.status(200).json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});

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

app.listen(PORT, () => console.log(`API Read Service listening on port ${PORT}`));
