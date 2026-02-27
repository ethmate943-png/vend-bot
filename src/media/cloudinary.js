/**
 * Upload WhatsApp media to Cloudinary for permanent URLs.
 * Free tier: 25GB storage, 25GB bandwidth/month.
 */
const { Readable } = require('stream');

let cloudinary = null;
function getCloudinary() {
  if (cloudinary) return cloudinary;
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) return null;
  cloudinary = require('cloudinary').v2;
  cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret });
  return cloudinary;
}

function isConfigured() {
  return !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
}

/**
 * Upload image buffer to Cloudinary. Returns permanent secure_url or null.
 * @param {Buffer} buffer - Raw image bytes
 * @param {string} vendorId - For folder path
 * @param {string} sku - Public id (unique per vendor)
 */
async function uploadImageToCloudinary(buffer, vendorId, sku) {
  const cld = getCloudinary();
  if (!cld) return null;

  const safeSku = String(sku || 'item').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  const publicId = `vendbot/${vendorId}/${safeSku}`;

  return new Promise((resolve, reject) => {
    const uploadStream = cld.uploader.upload_stream(
      {
        folder: `vendbot/${vendorId}`,
        public_id: safeSku,
        resource_type: 'image',
        overwrite: true
      },
      (err, result) => {
        if (err) {
          console.error('[CLOUDINARY] Image upload error:', err.message);
          reject(err);
        } else resolve(result?.secure_url || null);
      }
    );

    const readStream = Readable.from(buffer);
    readStream.on('error', reject);
    readStream.pipe(uploadStream);
  });
}

/**
 * Upload video buffer. Caller should check size (e.g. max 50MB) before calling.
 */
async function uploadVideoToCloudinary(buffer, vendorId, label = 'video') {
  const cld = getCloudinary();
  if (!cld) return null;

  const safeLabel = String(label).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);

  return new Promise((resolve, reject) => {
    const uploadStream = cld.uploader.upload_stream(
      {
        folder: `vendbot/${vendorId}/videos`,
        public_id: safeLabel,
        resource_type: 'video',
        overwrite: true
      },
      (err, result) => {
        if (err) {
          console.error('[CLOUDINARY] Video upload error:', err.message);
          reject(err);
        } else resolve(result?.secure_url || null);
      }
    );

    const readStream = Readable.from(buffer);
    readStream.on('error', reject);
    readStream.pipe(uploadStream);
  });
}

/**
 * Delete asset by public_id (e.g. when vendor removes product).
 */
async function deleteMedia(publicId, resourceType = 'image') {
  const cld = getCloudinary();
  if (!cld) return;
  try {
    await cld.uploader.destroy(publicId, { resource_type: resourceType });
  } catch (err) {
    console.error('[CLOUDINARY] Delete error:', err.message);
  }
}

module.exports = {
  isConfigured,
  uploadImageToCloudinary,
  uploadVideoToCloudinary,
  deleteMedia
};
