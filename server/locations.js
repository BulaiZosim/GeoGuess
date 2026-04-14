// Weighted land regions for random point generation
// Each region: [latMin, latMax, lngMin, lngMax, weight]
// Weight reflects Street View coverage density — higher = more likely to pick from this region
const LAND_REGIONS = [
  // Europe (great coverage)
  [36, 60, -10, 30, 20],
  // Scandinavia
  [55, 71, 5, 30, 5],
  // UK & Ireland
  [50, 59, -11, 2, 5],

  // North America (great coverage)
  [25, 50, -125, -65, 20],
  // Mexico
  [15, 32, -118, -86, 8],
  // Canada south
  [43, 55, -130, -60, 5],

  // South America (good coverage)
  [-35, 5, -80, -35, 12],

  // Japan & South Korea (great coverage)
  [31, 46, 126, 146, 8],

  // Southeast Asia (decent coverage)
  [-8, 20, 95, 140, 8],

  // Australia (good coverage)
  [-38, -12, 113, 154, 8],
  // New Zealand
  [-47, -34, 166, 178, 3],

  // South Africa
  [-35, -22, 16, 33, 4],

  // Middle East / Turkey
  [30, 42, 25, 55, 5],

  // India (decent coverage)
  [8, 35, 68, 90, 5],

  // Russia (western, has some coverage)
  [50, 62, 30, 60, 3],

  // East Africa (Kenya, Uganda, Tanzania)
  [-10, 4, 28, 42, 3],

  // North Africa (Morocco, Tunisia)
  [28, 37, -10, 12, 3],

  // Iceland
  [63, 66, -24, -13, 2],
];

// Pick a random point weighted by region coverage
function generateRandomPoint() {
  const totalWeight = LAND_REGIONS.reduce((sum, r) => sum + r[4], 0);
  let rand = Math.random() * totalWeight;

  for (const region of LAND_REGIONS) {
    rand -= region[4];
    if (rand <= 0) {
      const lat = region[0] + Math.random() * (region[1] - region[0]);
      const lng = region[2] + Math.random() * (region[3] - region[2]);
      return { lat: parseFloat(lat.toFixed(4)), lng: parseFloat(lng.toFixed(4)) };
    }
  }

  // Fallback
  const r = LAND_REGIONS[0];
  return {
    lat: parseFloat((r[0] + Math.random() * (r[1] - r[0])).toFixed(4)),
    lng: parseFloat((r[2] + Math.random() * (r[3] - r[2])).toFixed(4)),
  };
}

module.exports = { generateRandomPoint };
