// Creating test databases and collections for testing
// Create test database 'testdb'
db = db.getSiblingDB('testdb');

// Create collections with test data
db.users.insertMany([
  { name: 'Ivan', email: 'ivan@example.com', age: 30 },
  { name: 'Maria', email: 'maria@example.com', age: 25 },
  { name: 'Alex', email: 'alex@example.com', age: 40 }
]);

db.products.insertMany([
  { name: 'Laptop', price: 1200, category: 'Electronics' },
  { name: 'Smartphone', price: 800, category: 'Electronics' },
  { name: 'Book', price: 20, category: 'Literature' }
]);

db.orders.insertMany([
  { user: 'ivan@example.com', product: 'Laptop', date: new Date() },
  { user: 'maria@example.com', product: 'Smartphone', date: new Date() }
]);

// Create test database 'proddb' for simulating second database
db = db.getSiblingDB('proddb');

db.customers.insertMany([
  { name: 'Company A', contact: 'contact@companya.com' },
  { name: 'Company B', contact: 'contact@companyb.com' }
]);

db.invoices.insertMany([
  { customer: 'Company A', amount: 5000, paid: true },
  { customer: 'Company B', amount: 3000, paid: false }
]);

print('Test database initialization completed'); 