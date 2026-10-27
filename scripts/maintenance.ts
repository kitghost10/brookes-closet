import { runMaintenance } from "../src/lib/maintenance";
import { getDb } from "../src/lib/db";

runMaintenance()
  .then(async (r) => { console.log(r); await (await getDb()).close(); })
  .catch((e) => { console.error(e); process.exit(1); });
