// carbon-track: returns estimated CO2e emissions for a shipment.
// Uses industry-standard freight emission factors:
//   - Truck LTL: ~0.062 kg CO2e per tonne-km (consolidated)
//   - Industry baseline: 0.092 kg CO2e per tonne-km (less efficient)
//   - Tree absorbs ~21 kg CO2/year (offset equivalent)
//   - 1 L gasoline = 2.31 kg CO2 (relatable equivalent)
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json"
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  let billable_lbs = 0, distance_km = 0, mode = "truck";
  if (req.method === "GET") {
    const u = new URL(req.url);
    billable_lbs = Number(u.searchParams.get("billable_lbs") || 0);
    distance_km = Number(u.searchParams.get("distance_km") || 0);
    mode = String(u.searchParams.get("mode") || "truck");
  } else {
    const b = await req.json().catch(() => ({}));
    billable_lbs = Number(b.billable_lbs || 0);
    distance_km = Number(b.distance_km || 0);
    mode = String(b.mode || "truck");
  }
  if (billable_lbs <= 0 || distance_km <= 0) {
    return json({ ok: false, error: "billable_lbs + distance_km required (positive numbers)" }, 400);
  }
  const tonnes = billable_lbs * 0.000453592;

  // Emission factors (kg CO2e per tonne-km)
  const factors: Record<string, { oke: number; industry: number; label: string }> = {
    truck:     { oke: 0.062, industry: 0.092, label: "Consolidated trucking" },
    truckload: { oke: 0.048, industry: 0.075, label: "Full truckload" },
    rail:      { oke: 0.018, industry: 0.022, label: "Rail intermodal" },
    air:       { oke: 0.602, industry: 0.690, label: "Air freight" },
  };
  const f = factors[mode] || factors.truck;

  const okeKg = tonnes * distance_km * f.oke;
  const industryKg = tonnes * distance_km * f.industry;
  const savedKg = Math.max(0, industryKg - okeKg);

  // Relatable equivalents
  const litresGas = okeKg / 2.31;            // 1L gasoline = 2.31 kg CO2
  const treesYearEquiv = okeKg / 21;          // mature tree absorbs ~21 kg/year
  const carKm = okeKg / 0.171;                // average car ~ 0.171 kg CO2/km

  return json({
    ok: true,
    inputs: { billable_lbs, distance_km, mode },
    factors_kg_per_tonne_km: f,
    tonne_km: Number((tonnes * distance_km).toFixed(2)),
    oke_kg: Number(okeKg.toFixed(2)),
    industry_baseline_kg: Number(industryKg.toFixed(2)),
    saved_vs_baseline_kg: Number(savedKg.toFixed(2)),
    equivalents: {
      gasoline_litres: Number(litresGas.toFixed(2)),
      car_kilometres: Number(carKm.toFixed(1)),
      trees_year_to_offset: Number(treesYearEquiv.toFixed(2))
    },
    methodology: "GHG Protocol / NRCan freight emission factors. OKE values reflect consolidated routing efficiency vs industry mean."
  });
});
