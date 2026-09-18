#!/usr/bin/env node
import {mkdirSync, createWriteStream} from "node:fs";
import {once} from "node:events";

const output = process.argv[2] || "forecasting/data/synthetic_transactions.csv";
const days = Number(process.env.SYNTHETIC_FORECAST_DAYS || 365);
const vendors = Number(process.env.SYNTHETIC_FORECAST_VENDORS || 24);
const offersPerVendor = Number(process.env.SYNTHETIC_OFFERS_PER_VENDOR || 4);
const endDate = new Date(`${process.env.SYNTHETIC_FORECAST_END_DATE || new Date().toISOString().slice(0, 10)}T00:00:00Z`);
endDate.setUTCDate(endDate.getUTCDate() - 1);

function hash(input) {
  let value = 2166136261;
  for (const character of input) value = Math.imul(value ^ character.charCodeAt(0), 16777619);
  return (value >>> 0) / 4294967296;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function csv(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

mkdirSync(output.split("/").slice(0, -1).join("/") || ".", {recursive: true});
const stream = createWriteStream(output);
stream.write("created_at,vendor_id,vendor_name,offer_id,type,total_amount,final_amount,discount_amount,cashback_amount\n");
let rows = 0;

for (let dayIndex = days - 1; dayIndex >= 0; dayIndex -= 1) {
  const date = new Date(endDate);
  date.setUTCDate(date.getUTCDate() - dayIndex);
  const dayOfWeek = date.getUTCDay();
  for (let vendorIndex = 1; vendorIndex <= vendors; vendorIndex += 1) {
    const vendorId = `syn-vendor-${String(vendorIndex).padStart(3, "0")}`;
    const vendorName = `Synthetic Vendor ${vendorIndex}`;
    const quality = 0.65 + hash(`${vendorId}:quality`) * 0.8;
    for (let offerIndex = 1; offerIndex <= offersPerVendor; offerIndex += 1) {
      const offerId = `${vendorId}-offer-${String(offerIndex).padStart(2, "0")}`;
      const discount = 5 + Math.floor(hash(`${offerId}:discount`) * 26);
      const seasonality = dayOfWeek === 5 || dayOfWeek === 6 ? 1.35 : dayOfWeek === 0 ? 0.8 : 1;
      const campaignPulse = 0.85 + hash(`${offerId}:${isoDate(date)}:pulse`) * 0.5;
      const baseDemand = (1.4 + vendorIndex % 7) * quality * (1 + discount / 70);
      const redemptions = Math.max(0, Math.floor(baseDemand * seasonality * campaignPulse + hash(`${offerId}:${isoDate(date)}:noise`) * 2 - 0.5));
      for (let transactionIndex = 0; transactionIndex < redemptions; transactionIndex += 1) {
        const total = 25 + Math.round(hash(`${offerId}:${isoDate(date)}:${transactionIndex}:amount`) * 90);
        const discountAmount = Math.round(total * discount / 100 * 100) / 100;
        const finalAmount = Math.round((total - discountAmount) * 100) / 100;
        const cashback = Math.round(finalAmount * 0.01 * 100) / 100;
        const timestamp = `${isoDate(date)}T${String(8 + (transactionIndex % 12)).padStart(2, "0")}:${String((transactionIndex * 17) % 60).padStart(2, "0")}:00.000Z`;
        const row = [timestamp, vendorId, vendorName, offerId, "offer", total, finalAmount, discountAmount, cashback].map(csv).join(",") + "\n";
        if (!stream.write(row)) await once(stream, "drain");
        rows += 1;
      }
    }
  }
}

stream.end();
await once(stream, "close");
console.log(JSON.stringify({output, days, vendors, offers: vendors * offersPerVendor, rows, endDate: isoDate(endDate)}));
