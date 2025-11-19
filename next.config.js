/** @type {import('next').NextConfig} */
const nextConfig = {
  /* config options here */
  maxDuration: 60, // Allow longer server timeouts for AI processing
  api: {
    bodyParser: {
      sizeLimit: '10mb', // Allow reasonable chunk sizes
    },
  },
};

module.exports = nextConfig;
