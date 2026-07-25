const fs = require('fs');
const path = require('path');

const TRACKING_FILE = path.join(__dirname, 'printed-orders.json');

function getPrintedOrders() {
  try {
    if (fs.existsSync(TRACKING_FILE)) {
      const content = fs.readFileSync(TRACKING_FILE, 'utf8');
      if (content.trim()) {
        return JSON.parse(content);
      }
    }
  } catch (e) {
    console.error('Error reading printed-orders.json:', e.message);
  }
  return {};
}

function isOrderPrinted(orderId) {
  if (!orderId) return false;
  const printed = getPrintedOrders();
  if (printed[orderId]) return true;

  try {
    const db = require('./db');
    const row = db.prepare('SELECT is_printed FROM orders WHERE id = ?').get(orderId);
    if (row && row.is_printed === 1) {
      printed[orderId] = true;
      return true;
    }
  } catch (e) {}

  return false;
}

function markOrderPrinted(orderId) {
  if (!orderId) return;
  const printed = getPrintedOrders();
  printed[orderId] = true;
  try {
    fs.writeFileSync(TRACKING_FILE, JSON.stringify(printed, null, 2));
  } catch (e) {
    console.error('Error writing printed-orders.json:', e.message);
  }

  try {
    const db = require('./db');
    db.prepare('UPDATE orders SET is_printed = 1 WHERE id = ?').run(orderId);
  } catch (e) {}
}

module.exports = {
  getPrintedOrders,
  isOrderPrinted,
  markOrderPrinted
};
