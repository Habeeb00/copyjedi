require('dotenv').config();
const mongoose = require('mongoose');

console.log('Attempting to connect to MongoDB Atlas...');
console.log('Using connection string (partial):', process.env.MONGODB_URI.substring(0, 20) + '...');

mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('Connected to MongoDB Atlas successfully!');
    mongoose.connection.close();
  })
  .catch(err => {
    console.error('Failed to connect to MongoDB Atlas:', err);
  });