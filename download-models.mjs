import fs from 'fs';
import path from 'path';
import https from 'https';

const baseUrl = 'https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights/';
const modelsDir = path.join(process.cwd(), 'public', 'models');

if (!fs.existsSync(modelsDir)) {
  fs.mkdirSync(modelsDir, { recursive: true });
}

const files = [
  'tiny_face_detector_model-weights_manifest.json',
  'tiny_face_detector_model-shard1',
  'face_landmark_68_tiny_model-weights_manifest.json',
  'face_landmark_68_tiny_model-shard1',
  // Phase 2c: full landmark model (required for descriptor extraction)
  'face_landmark_68_model-weights_manifest.json',
  'face_landmark_68_model-shard1',
  // Phase 2c: face recognition / descriptor model
  'face_recognition_model-weights_manifest.json',
  'face_recognition_model-shard1',
  'face_recognition_model-shard2',
];

async function download() {
  for (const file of files) {
    const url = baseUrl + file;
    const dest = path.join(modelsDir, file);
    console.log(`Downloading ${file}...`);
    
    await new Promise((resolve, reject) => {
      https.get(url, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`Failed to get ${url} (${res.statusCode})`));
          return;
        }
        const fileStream = fs.createWriteStream(dest);
        res.pipe(fileStream);
        fileStream.on('finish', () => {
          fileStream.close();
          resolve(true);
        });
      }).on('error', reject);
    });
  }
  console.log('All models downloaded successfully!');
}

download().catch(console.error);
