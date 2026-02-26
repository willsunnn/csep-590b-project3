export interface Order {
  id: string;
  customerId: string;
  items: Array<{ productId: string; quantity: number }>;
  status: 'PENDING' | 'STOCK_VALIDATED' | 'INVENTORY_UPDATED' | 'COMPLETED' | 'FAILED';
  createdAt: string;
}

export interface Inventory {
  productId: string;
  stock: number;
}
