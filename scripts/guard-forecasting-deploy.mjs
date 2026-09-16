const project = process.argv[2] || process.env.GCLOUD_PROJECT || "";
const forbidden = new Set(["reelx-backend", "realx-dev", "realx-dev-107"]);
if (!project || forbidden.has(project)) {
  throw new Error(`Refusing forecasting deployment to unsafe Firebase project: ${project || "missing"}`);
}
if (!/^realx-forecasting(?:-[a-z0-9-]+)?$/.test(project)) {
  throw new Error(`Forecasting deployment project must use the realx-forecasting-* namespace: ${project}`);
}
console.log(`Forecasting deployment target approved: ${project}`);
