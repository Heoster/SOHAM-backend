const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('🚀 Setting up SOHAM Backend Server...');

// 1. Create .env if it doesn't exist
const envPath = path.join(__dirname, '.env');
const envLocalPath = path.join(__dirname, '.env.local');

if (!fs.existsSync(envPath)) {
  if (fs.existsSync(envLocalPath)) {
    console.log('📝 Copying .env.local to .env...');
    fs.copyFileSync(envLocalPath, envPath);
  } else {
    console.log('📝 Creating .env from template...');
    const template = `GROQ_API_KEY=your_groq_key_here
GOOGLE_API_KEY=
TAVILY_API_KEY=
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_AI_API_TOKEN=
SUPABASE_URL=
SUPABASE_ANON_KEY=
UPSTASH_VECTOR_REST_URL=
UPSTASH_VECTOR_REST_TOKEN=
`;
    fs.writeFileSync(envPath, template);
    console.log('⚠️ Please update .env with your API keys.');
  }
} else {
  console.log('✅ .env already exists.');
}

// 2. Install dependencies if node_modules doesn't exist
const nodeModulesPath = path.join(__dirname, 'node_modules');
if (!fs.existsSync(nodeModulesPath)) {
  console.log('📦 Installing dependencies (this may take a minute)...');
  try {
    execSync('npm install', { stdio: 'inherit' });
  } catch (err) {
    console.error('❌ Failed to install dependencies:', err.message);
  }
} else {
  console.log('✅ node_modules already exists.');
}

console.log('\n✨ Setup complete!');
console.log('👉 Run "npm run dev" to start the server.');
