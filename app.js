require('dotenv').config()
require('./src/connect/mongodb')
const bodyParser = require('body-parser')
const express = require('express')
const session = require('express-session')
var MemoryStore = require('memorystore')(session)
const UserService = require('./src/user')
const Stripe = require('./src/connect/stripe')
const setCurrentUser = require('./src/middleware/setCurrentUser')
const hasPlan = require('./src/middleware/hasPlan')
const multer = require('multer')
const mongoose = require('mongoose')
const nodeMailer = require('nodemailer')

const userSchema = require("./src/user/user.model")

const app = express()
app.use(session({
  saveUninitialized: false,
  cookie: { maxAge: 86400000 },
  store: new MemoryStore({
    checkPeriod: 86400000 // prune expired entries every 24h
  }),
  resave: false,
  secret: 'keyboard cat'
}))

app.use('/webhook', bodyParser.raw({ type: 'application/json' }))

app.use(bodyParser.json())
app.use(bodyParser.urlencoded({ extended: true }))

app.use(express.static('public'))
app.engine('html', require('ejs').renderFile)

const productToPriceMap = {
  basic: process.env.PRODUCT_BASIC,
  pro: process.env.PRODUCT_PRO
}

app.get('/none', [setCurrentUser, hasPlan('none')], async function (
  req,
  res,
  next
) {
  res.status(200).render('none.ejs')
})

app.get('/basic', [setCurrentUser, hasPlan('basic')], async function (
  req,
  res,
  next
) {
  res.status(200).render('basic.ejs')
})

app.get('/pro', [setCurrentUser, hasPlan('pro')], async function (
  req,
  res,
  next
) {
  res.status(200).render('pro.ejs')
})

app.get('/', function (req, res) {
  res.render('login.ejs')
})

// Get Users
app.get('/getUsers', async function (req, res) {
  let users = await UserService.getUsers()
  res.status(200).json(users)
})

// User Profile
app.get('/userProfile/:id', async function (req, res) {
  userSchema.findById(req.params.id, (error, data) => {
    if (error) {
      return next(error);
    } else {
      res.status(200).json({
        msg: data
      })
    }
  })
})

// Update User
app.put('/updateUser/:id', function (req, res, next) {
  userSchema.findByIdAndUpdate(req.params.id, {
    $set: req.body
  }, (error, data) => {
    if (error) {
      return next(error);
      console.log(error)
    } else {
      res.json(data)
      console.log('User successfully updated!')
    }
  })
})

// Delete User
app.delete('/deleteUser/:id', function (req, res, next) {
  userSchema.findByIdAndRemove(req.params.id, (error, data) => {
    if (error) {
      return next(error);
    } else {
      res.status(200).json({
        msg: data
      })
    }
  })
})

app.get('/account', async function (req, res) {
  let { email } = req.session
  let customer = await UserService.getUserByEmail(email)
  if (!customer) {
    res.redirect('/')
  } else {
    res.render('account.ejs', { customer })
  }
})

app.get('/products', async function (req, res) {
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

  const products = await stripe.products.list({
    //limit: 3,
    expand: ['data.default_price']
  });

  res.status(200).json({ products })
})

app.post('/login', async function (req, res) {
  const { email, firstName, lastName, password, number, company, creditCard } = req.body
  console.log('creditCard', creditCard)

  let customer = await UserService.getUserByEmail(email)
  let customerInfo = {}

  if (!customer) {
    console.log(`email ${email} does not exist. Making one. `)
    try {
      customerInfo = await Stripe.addNewCustomer(email)

      customer = await UserService.addUser({
        email: customerInfo.email,
        firstName: firstName,
        lastName: lastName,
        password: password,
        number: number,
        copmpany: company,
        creditCard: creditCard,
        billingID: customerInfo.id,
        plan: 'none',
        endDate: null
      })

      console.log(customer)

      console.log(
        `A new user signed up and addded to DB. The ID for ${email} is ${JSON.stringify(
          customerInfo
        )}`
      )

      console.log(`User also added to DB. Information from DB: ${customer}`)
    } catch (e) {
      console.log(e)
      res.status(200).json({ e })
      return
    }
  } else {
    const isTrialExpired =
      customer.plan != 'none' && customer.endDate < new Date().getTime()

    if (isTrialExpired) {
      console.log('trial expired')
      customer.hasTrial = false
      customer.save()
    } else {
      console.log(
        'no trial information',
        customer.hasTrial,
        customer.plan != 'none',
        customer.endDate < new Date().getTime()
      )
    }

    customerInfo = await Stripe.getCustomerByID(customer.billingID)
    console.log(
      `The existing ID for ${email} is ${JSON.stringify(customerInfo)}`
    )
  }

  req.session.email = email

  // res.render('account.ejs', {
  //   customer,
  //   customerInfo,
  //   email
  // })

  res.redirect('/account')
})

app.post('/checkout', setCurrentUser, async (req, res) => {
  const customer = req.user
  const { product, customerID } = req.body
  const price = productToPriceMap[product]
  try {
    const session = await Stripe.createCheckoutSession(customerID, price)

    const ms =
      new Date().getTime() + 1000 * 60 * 60 * 24 * process.env.TRIAL_DAYS
    const n = new Date(ms)

    customer.plan = product
    customer.hasTrial = true
    customer.endDate = n
    customer.save()

    res.send({
      sessionId: session.id
    })
  } catch (e) {
    console.log(e)
    res.status(400)
    return res.send({
      error: {
        message: e.message
      }
    })
  }
})

app.post('/billing', setCurrentUser, async (req, res) => {
  const { customer } = req.body
  console.log('customer', customer)

  const session = await Stripe.createBillingSession(customer)
  console.log('session', session)

  res.json({ url: session.url })
})

app.post('/webhook', async (req, res) => {
  let event

  try {
    event = Stripe.createWebhook(req.body, req.header('Stripe-Signature'))
  } catch (err) {
    console.log(err)
    return res.sendStatus(400)
  }

  const data = event.data.object

  console.log(event.type, data)
  switch (event.type) {
    case 'customer.created':
      console.log(JSON.stringify(data))
      break
    case 'invoice.paid':
      break
    case 'customer.subscription.created': {
      const user = await UserService.getUserByBillingID(data.customer)

      if (data.plan.id === process.env.PRODUCT_BASIC) {
        console.log('You are talking about basic product')
        user.plan = 'basic'
      }

      if (data.plan.id === process.env.PRODUCT_PRO) {
        console.log('You are talking about pro product')
        user.plan = 'pro'
      }

      user.hasTrial = true
      user.endDate = new Date(data.current_period_end * 1000)

      await user.save()

      break
    }
    case 'customer.subscription.updated': {
      // started trial
      const user = await UserService.getUserByBillingID(data.customer)

      if (data.plan.id == process.env.PRODUCT_BASIC) {
        console.log('You are talking about basic product')
        user.plan = 'basic'
      }

      if (data.plan.id === process.env.PRODUCT_PRO) {
        console.log('You are talking about pro product')
        user.plan = 'pro'
      }

      const isOnTrial = data.status === 'trialing'

      if (isOnTrial) {
        user.hasTrial = true
        user.endDate = new Date(data.current_period_end * 1000)
      } else if (data.status === 'active') {
        user.hasTrial = false
        user.endDate = new Date(data.current_period_end * 1000)
      }

      if (data.canceled_at) {
        // cancelled
        console.log('You just canceled the subscription' + data.canceled_at)
        user.plan = 'none'
        user.hasTrial = false
        user.endDate = null
      }
      console.log('actual', user.hasTrial, data.current_period_end, user.plan)

      await user.save()
      console.log('customer changed', JSON.stringify(data))
      break
    }
    default:
  }
  res.sendStatus(200)
})

//Upload PDF files
const multerStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "files");
  },
  filename: (req, file, cb) => {
    const ext = file.mimetype.split("/")[1];
    cb(null, `${file.fieldname}-${Date.now()}.${ext}`);
  },
});

// Multer Filter
const multerFilter = (req, file, cb) => {
  if (file.mimetype.split("/")[1] === "pdf") {
    cb(null, true);
  } else {
    cb(new Error("Not a PDF File!!"), false);
  }
};

const upload = multer({
  storage: multerStorage,
  fileFilter: multerFilter,
});

// Create a new File
app.post("/pdf", upload.single("file"), async function (req, res) {
  const userId = req.body.user
  const url = req.protocol + '://' + req.get('host')
  const file = new Array({
    _id: new mongoose.Types.ObjectId(),
    name: req.file.filename
  })
  console.log(file)
  await userSchema.findOneAndUpdate({ _id: req.body.user }, { $push: { files: file } });
  res.send("File was added successfully");
});

// Mailer
app.post('/send-email', function (req, res) {
  let transporter = nodeMailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: 'omarbardoura@gmail.com',
      pass: 'fzmsumtlnwmwtybr'
    }
  });
  let mailOptions = {
    from: '"Omar Bardoura" <omarbardoura@gmail.com>', // sender address
    to: req.body.to, // list of receivers
    subject: req.body.subject, // Subject line
    text: req.body.body, // plain text body
    html: '<b>Test Email</b>' // html body
  };

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      return console.log(error);
    }
    console.log('Message %s sent: %s', info.messageId, info.response);
    res.render('index');
  });
});

const port = process.env.PORT || 4242

app.listen(port, () => console.log(`Listening on port ${port}!`))
