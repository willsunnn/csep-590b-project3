import axios from 'axios';

const API_URL = process.env.API_URL || 'http://localhost:3000'; // Default to a local endpoint or placeholder

async function sendOrder(orderId: number) {
  try {
    const response = await axios.post(`${API_URL}/orders`, {
      customerId: `cust-${orderId}`,
      items: [
        { productId: 'prod-1', quantity: 1 },
        { productId: 'prod-2', quantity: 2 },
      ],
    });
    console.log(`Order ${orderId} Response:`, response.status, response.data);
  } catch (error: any) {
    console.error(`Order ${orderId} Error:`, error.response?.status, error.message);
  }
}

async function runLoadTest(numOrders: number = 100) {
  console.log(`Starting load test with ${numOrders} orders...`);
  const startTime = Date.now();
  
  const promises = [];
  for (let i = 0; i < numOrders; i++) {
    promises.push(sendOrder(i));
  }
  
  await Promise.all(promises);
  
  const endTime = Date.now();
  console.log(`Finished load test in ${endTime - startTime}ms`);
}

runLoadTest(50);
