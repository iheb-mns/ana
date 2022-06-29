const mongoose = require('mongoose')
const Schema = mongoose.Schema

const userSchema = new Schema({
  email: String,
  firstName: String,
  lastName: String,
  password: String,
  number: String,
  company: String,
  role: { type: String, enum: ['admin', 'user'], default: 'user' },
  billingID: String,
  plan: { type: String, enum: ['none', 'basic', 'pro'], default: 'none' },
  hasTrial: { type: Boolean, default: false },
  endDate: { type: Date, default: null },
  creditCard: [{
    firstName: String,
    lastName: String,
    email: String,
    cardNumber: Number,
    verificationValue: Number,
    month: Number,
    year: Number,
  }],
  files: [{
    name: String
  }]
})

const userModel = mongoose.model('user', userSchema, 'user')

module.exports = userModel
