// Continent detection from lat/lng using bounding boxes
// Good enough for fun stats — not scientifically precise

function getContinent(lat, lng) {
  // Order matters — check more specific regions first

  // Australia/Oceania
  if (lat < -10 && lng > 110 && lng < 180) return 'Oceania';
  if (lat < 0 && lng > 160) return 'Oceania';
  if (lat > -50 && lat < -8 && lng > 110 && lng < 155) return 'Oceania';
  // New Zealand
  if (lat > -48 && lat < -33 && lng > 165 && lng < 179) return 'Oceania';

  // Southeast Asia (before broader Asia check)
  if (lat > -11 && lat < 25 && lng > 90 && lng < 145) return 'Asia';

  // Asia
  if (lat > 0 && lng > 25 && lng < 180) return 'Asia';
  if (lat > 25 && lng > 25) return 'Asia';

  // Africa
  if (lat > -35 && lat < 37 && lng > -20 && lng < 55) return 'Africa';

  // Europe
  if (lat > 35 && lat < 72 && lng > -25 && lng < 45) return 'Europe';

  // South America
  if (lat > -60 && lat < 15 && lng > -85 && lng < -30) return 'South America';

  // North America (including Central America & Caribbean)
  if (lat > 7 && lat < 85 && lng > -170 && lng < -25) return 'North America';

  // Antarctica
  if (lat < -60) return 'Antarctica';

  // Fallback
  if (lng < -25) return 'North America';
  if (lng > 25) return 'Asia';
  return 'Europe';
}

// Reverse geocode using Nominatim (free, no API key)
async function getCountryName(lat, lng) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=3&accept-language=en`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'GeoGuess-Game/1.0' },
    });
    const data = await response.json();
    return data.address?.country || null;
  } catch (e) {
    console.warn('Nominatim reverse geocode failed:', e.message);
    return null;
  }
}

module.exports = { getContinent, getCountryName };
