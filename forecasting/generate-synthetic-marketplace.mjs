#!/usr/bin/env node
import {mkdirSync, createWriteStream} from "node:fs";
import {once} from "node:events";

const output = process.argv[2] || "forecasting/data/synthetic_events.csv";
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
function isoDate(date) { return date.toISOString().slice(0, 10); }
function csv(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

mkdirSync(output.split("/").slice(0, -1).join("/") || ".", {recursive: true});
const stream = createWriteStream(output);
stream.write("event_date,vendor_id,offer_id,event_type,event_count,platform\n");
let rows = 0;

for (let dayIndex = days - 1; dayIndex >= 0; dayIndex -= 1) {
  const date = new Date(endDate);
  date.setUTCDate(date.getUTCDate() - dayIndex);
  const dayOfWeek = date.getUTCDay();
  for (let vendorIndex = 1; vendorIndex <= vendors; vendorIndex += 1) {
    const vendorId = `syn-vendor-${String(vendorIndex).padStart(3, "0")}`;
    const quality = 0.65 + hash(`${vendorId}:quality`) * 0.8;
    for (let offerIndex = 1; offerIndex <= offersPerVendor; offerIndex += 1) {
      const offerId = `${vendorId}-offer-${String(offerIndex).padStart(2, "0")}`;
      const discount = 5 + Math.floor(hash(`${offerId}:discount`) * 26);
      const seasonality = dayOfWeek === 5 || dayOfWeek === 6 ? 1.35 : dayOfWeek === 0 ? 0.8 : 1;
      const pulse = 0.85 + hash(`${offerId}:${isoDate(date)}:pulse`) * 0.5;
      const baseDemand = (1.4 + vendorIndex % 7) * quality * (1 + discount / 70);
      const purchases = Math.max(0, Math.floor(baseDemand * seasonality * pulse + hash(`${offerId}:${isoDate(date)}:noise`) * 2 - 0.5));
      const impressions = Math.max(20, Math.floor((18 + baseDemand * 24) * seasonality * (0.9 + hash(`${offerId}:${isoDate(date)}:impressions`) * 0.3)));
      const clicks = Math.max(purchases, Math.floor(impressions * (0.07 + hash(`${offerId}:ctr`) * 0.1)));
      const saves = Math.max(0, Math.floor(clicks * (0.18 + hash(`${offerId}:save-rate`) * 0.2)));
      for (const [eventType, eventCount] of [["impression", impressions], ["click", clicks], ["save", saves], ["purchase", purchases]]) {
        const row = [isoDate(date), vendorId, offerId, eventType, eventCount, hash(`${offerId}:platform`) > 0.5 ? "ios" : "android"].map(csv).join(",") + "\n";
        if (!stream.write(row)) await once(stream, "drain");
        rows += 1;
      }
    }
  }
}
stream.end();
await once(stream, "close");
console.log(JSON.stringify({output, days, vendors, offers: vendors * offersPerVendor, rows, endDate: isoDate(endDate)}));
