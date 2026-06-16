import { getRedis } from '../lib/db/redis'

async function check() {
  const txId = '0x46986200afe2c8766da50365faf26dd8d5c8eb5b5eb70c4245b915a6083d3421'
  const redis = getRedis()
  if (!redis) {
    console.error('Redis not configured!')
    process.exit(1)
  }
  try {
    const otp = await redis.get(`demo:otp:${txId}`)
    console.log('OTP IN REDIS:', otp)
  } catch (err) {
    console.error('Redis error:', err)
  }
}

check().then(() => process.exit(0))
