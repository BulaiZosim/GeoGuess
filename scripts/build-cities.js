// Build script: downloads GeoNames cities15000, filters to population >= 100,000,
// and writes server/cities.json. Safe to re-run.
//
// Usage: node scripts/build-cities.js

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const MIN_POPULATION = 100000;
const ZIP_URL = 'https://download.geonames.org/export/dump/cities15000.zip';

const ROOT = path.resolve(__dirname, '..');
const RAW_DIR = path.join(ROOT, 'data', 'raw');
const ZIP_PATH = path.join(RAW_DIR, 'cities15000.zip');
const TXT_PATH = path.join(RAW_DIR, 'cities15000.txt');
const OUT_PATH = path.join(ROOT, 'server', 'cities.json');

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(dest);
        return download(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => {
      file.close();
      fs.existsSync(dest) && fs.unlinkSync(dest);
      reject(err);
    });
  });
}

function extractZip(zipPath, outDir) {
  if (process.platform === 'win32') {
    // PowerShell's Expand-Archive is reliable on Windows 10/11.
    const ps = `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${outDir.replace(/'/g, "''")}' -Force`;
    execSync(`powershell -NoProfile -Command "${ps}"`, { stdio: 'inherit' });
  } else {
    execSync(`unzip -o "${zipPath}" -d "${outDir}"`, { stdio: 'inherit' });
  }
}

async function main() {
  fs.mkdirSync(RAW_DIR, { recursive: true });

  if (!fs.existsSync(ZIP_PATH)) {
    console.log(`Downloading ${ZIP_URL}...`);
    await download(ZIP_URL, ZIP_PATH);
  } else {
    console.log(`Using cached ${ZIP_PATH}`);
  }

  if (!fs.existsSync(TXT_PATH)) {
    console.log(`Extracting to ${RAW_DIR}...`);
    extractZip(ZIP_PATH, RAW_DIR);
  }

  console.log('Parsing...');
  const raw = fs.readFileSync(TXT_PATH, 'utf8');
  const lines = raw.split('\n');

  const cities = [];
  for (const line of lines) {
    if (!line) continue;
    const cols = line.split('\t');
    // GeoNames columns: 1 name, 4 lat, 5 lng, 8 country, 14 population
    const name = cols[1];
    const lat = parseFloat(cols[4]);
    const lng = parseFloat(cols[5]);
    const country = cols[8];
    const population = parseInt(cols[14], 10);
    if (!name || !isFinite(lat) || !isFinite(lng) || !isFinite(population)) continue;
    if (population < MIN_POPULATION) continue;
    cities.push({
      name,
      country,
      lat: parseFloat(lat.toFixed(4)),
      lng: parseFloat(lng.toFixed(4)),
      population,
    });
  }

  cities.sort((a, b) => b.population - a.population);

  fs.writeFileSync(OUT_PATH, JSON.stringify(cities) + '\n');
  console.log(`Wrote ${cities.length} cities (pop >= ${MIN_POPULATION}) to ${OUT_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
