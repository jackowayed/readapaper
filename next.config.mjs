/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: { ignoreDuringBuilds: false },
  serverExternalPackages: ["jsdom", "@mozilla/readability", "isomorphic-dompurify"],
};
export default nextConfig;
