const { RateLimiterRedis } = require('rate-limiter-flexible');
const ipRangeCheck = require('ip-range-check'); // For CIDR support

const rateLimiterConfig = {
  unlimited: new Set(config.api.rateLimiting.unlimited.ips),
  whitelist: new Set(config.api.rateLimiting.whitelist.ips),
  whitelistLimit: config.api.rateLimiting.whitelist.requestsPerSecond,
  standardLimit: config.api.rateLimiting.standard.requestsPerSecond
};

const rateLimiters = {
  whitelist: new RateLimiterRedis({
    storeClient: redisClient,
    keyPrefix: 'rate_limit_whitelist',
    points: 25,
    duration: 1,
    blockDuration: 30,
  }),
  standard: new RateLimiterRedis({
    storeClient: redisClient,
    keyPrefix: 'rate_limit_standard',
    points: 10,
    duration: 1,
    blockDuration: 30,
  }),
  // Add a penalty counter for repeated violations
  penalty: new RateLimiterRedis({
    storeClient: redisClient,
    keyPrefix: 'rate_limit_penalty',
    points: 50,
    duration: 3600,
    blockDuration: 3600
  })
};

async function rateLimitMiddleware(request, response, callback) {
  const ip = request.headers['x-forwarded-for']?.split(',')[0] ||
    request.connection.remoteAddress;

  try {
    // Check unlimited IPs first
    if (config.api.rateLimiting.unlimited.ips.some(range =>
      ipRangeCheck(ip, range))) {
      return callback(request, response);
    }

    // Check if IP is already blocked due to penalties
    try {
      const penaltyRes = await rateLimiters.penalty.get(ip);
      if (penaltyRes !== null && penaltyRes.consumedPoints > 50) {
        throw new Error('Too many violations');
      }
    } catch (e) {
      response.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': 3600
      });
      response.end(JSONbig.stringify({
        error: 'IP temporarily blocked due to too many violations',
        retryAfter: 3600
      }));
      return;
    }

    // Determine which rate limiter to use
    let limiter = rateLimiters.standard;
    if (config.api.rateLimiting.whitelist.ips.some(range =>
      ipRangeCheck(ip, range))) {
      limiter = rateLimiters.whitelist;
    }

    // Try to consume a point
    await limiter.consume(ip);

    // If successful, handle the request
    callback(request, response);

  } catch (error) {
    // Track violation
    try {
      await rateLimiters.penalty.consume(ip);
    } catch (e) {
      // If this fails, the penalty limit was exceeded
      if (e.msBeforeNext) {
        response.writeHead(429, {
          'Content-Type': 'application/json',
          'Retry-After': Math.ceil(e.msBeforeNext / 1000)
        });
        response.end(JSONbig.stringify({
          error: 'IP blocked due to repeated violations',
          retryAfter: Math.ceil(e.msBeforeNext / 1000)
        }));
        return;
      }
    }

    // Send rate limit exceeded response
    response.writeHead(429, {
      'Content-Type': 'application/json',
      'Retry-After': Math.ceil(error.msBeforeNext / 1000)
    });
    response.end(JSONbig.stringify({
      error: 'Too many requests',
      retryAfter: Math.ceil(error.msBeforeNext / 1000)
    }));
  }
}

module.exports = { rateLimitMiddleware };