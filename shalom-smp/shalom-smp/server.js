// Shalom SMP backend
// Handles: order creation, UroPay webhook (payment confirmation), admin approval, RCON delivery

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Rcon } = require('rcon-client');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DB_FILE = path.join(__dirname, 'orders.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const UROPAY_WEBHOOK_SECRET = process.env.UROPAY_WEBHOOK_SECRET || '';
const RCON_HOST = process.env.RCON_HOST || '127.0.0.1';
const RCON_PORT = parseInt(process.env.RCON_PORT || '25575', 10);
const RCON_PASSWORD = process.env.RCON_PASSWORD || '';

// Rank -> in-game command to run on approval. {ign} is replaced with the buyer's username.
const RANK_COMMANDS = {
  elite: 'lp user {ign} parent add elite',
  king:  'lp user {ign} parent add king',
  god:   'lp user {ign} parent add god'
};

const RANK_PRICES = { elite: 100, king: 220, god: 350 };

// ---------- tiny JSON "database" ----------
function readDB() {
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ orders: [] }, null, 2));
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// ---------- admin auth (simple bearer token) ----------
const activeTokens = new Set();

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token || !activeTokens.has(token)) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  activeTokens.add(token);
  res.json({ token });
});

// ---------- 1. Create an order (called from the checkout modal on the website) ----------
app.post('/api/create-order', (req, res) => {
  const { tier, ign, email } = req.body;
  const tierKey = String(tier || '').toLowerCase();

  if (!RANK_PRICES[tierKey]) return res.status(400).json({ error: 'Unknown tier' });
  if (!ign || !email) return res.status(400).json({ error: 'IGN and email required' });

  const db = readDB();
  const order = {
    id: crypto.randomUUID(),
    tier: tierKey,
    amount: RANK_PRICES[tierKey],
    ign,
    email,
    status: 'awaiting_payment', // awaiting_payment -> paid_pending_approval -> delivered
    createdAt: new Date().toISOString(),
    uropayOrderId: null
  };
  db.orders.push(order);
  writeDB(db);

  // ---------------------------------------------------------------------
  // TODO: Replace this block with a real call to UroPay's order-creation
  // API once you have their docs/merchant key. It should look roughly like:
  //
  // const uropayRes = await fetch('https://api.uropay.com/v1/orders', {
  //   method: 'POST',
  //   headers: { Authorization: `Bearer ${process.env.UROPAY_API_KEY}`, 'Content-Type': 'application/json' },
  //   body: JSON.stringify({
  //     amount: order.amount * 100, // if UroPay expects paise
  //     currency: 'INR',
  //     reference: order.id,
  //     redirect_url: `https://play.shalomsmp.in/order/${order.id}`,
  //     webhook_url: 'https://play.shalomsmp.in/webhook/uropay'
  //   })
  // });
  // const uropayData = await uropayRes.json();
  // order.uropayOrderId = uropayData.id;
  // checkoutUrl = uropayData.checkout_url;
  // ---------------------------------------------------------------------

  const checkoutUrl = null; // placeholder until real UroPay integration is wired in

  res.json({ orderId: order.id, checkoutUrl });
});

// ---------- 2. UroPay webhook: fires when a payment is confirmed ----------
// Point UroPay's "webhook URL" / "payment notification URL" setting at:
//   https://play.shalomsmp.in/webhook/uropay
app.post('/webhook/uropay', (req, res) => {
  // ---------------------------------------------------------------------
  // TODO: verify the webhook signature using UroPay's documented method,
  // e.g. an HMAC header. Skeleton (adjust header name / algorithm to match
  // UroPay's actual docs):
  //
  // const signature = req.headers['x-uropay-signature'];
  // const expected = crypto.createHmac('sha256', UROPAY_WEBHOOK_SECRET)
  //   .update(JSON.stringify(req.body)).digest('hex');
  // if (signature !== expected) return res.status(401).send('Invalid signature');
  // ---------------------------------------------------------------------

  const { reference, status, uropay_order_id } = req.body; // field names are placeholders — match to UroPay's real payload

  if (status !== 'success' && status !== 'paid') {
    return res.status(200).send('ignored'); // not a successful payment event
  }

  const db = readDB();
  const order = db.orders.find(o => o.id === reference);
  if (!order) return res.status(404).send('order not found');

  order.status = 'paid_pending_approval';
  order.uropayOrderId = uropay_order_id || order.uropayOrderId;
  order.paidAt = new Date().toISOString();
  writeDB(db);

  console.log(`[webhook] Order ${order.id} marked paid, awaiting admin approval.`);
  res.status(200).send('ok');
});

// ---------- 3. Admin: list orders ----------
app.get('/api/admin/orders', requireAdmin, (req, res) => {
  const db = readDB();
  res.json({ orders: db.orders.slice().reverse() });
});

// ---------- 4. Admin: approve an order -> runs the RCON command ----------
app.post('/api/admin/orders/:id/approve', requireAdmin, async (req, res) => {
  const db = readDB();
  const order = db.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status === 'delivered') return res.status(400).json({ error: 'Already delivered' });

  const template = RANK_COMMANDS[order.tier];
  if (!template) return res.status(400).json({ error: 'No command configured for this tier' });
  const command = template.replace('{ign}', order.ign);

  try {
    const rcon = await Rcon.connect({ host: RCON_HOST, port: RCON_PORT, password: RCON_PASSWORD });
    const response = await rcon.send(command);
    await rcon.end();

    order.status = 'delivered';
    order.deliveredAt = new Date().toISOString();
    order.rconResponse = response;
    writeDB(db);

    res.json({ success: true, command, response });
  } catch (err) {
    console.error('RCON error:', err.message);
    res.status(500).json({ error: 'Could not reach Minecraft server via RCON', detail: err.message });
  }
});

// ---------- 5. Admin: reject an order ----------
app.post('/api/admin/orders/:id/reject', requireAdmin, (req, res) => {
  const db = readDB();
  const order = db.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  order.status = 'rejected';
  writeDB(db);
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Shalom SMP backend running on http://localhost:${PORT}`));
