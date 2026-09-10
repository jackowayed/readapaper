/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: { ignoreDuringBuilds: true },
  serverExternalPackages: ["jsdom", "@mozilla/readability", "isomorphic-dompurify"],
};
export default nextConfig;
