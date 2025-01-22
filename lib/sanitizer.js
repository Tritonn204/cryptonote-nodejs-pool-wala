function validateAddress(address) {
  const escapedPrefix = config.addressPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const minLength = config.addressMinLength || 61;
  const maxLength = config.addressMaxLength || 63;
  const addressRegex = new RegExp(`^${escapedPrefix}[a-zA-Z0-9]{${minLength},${maxLength}}$`);
  return addressRegex.test(address);
}

function sanitizeInput(urlParts) {
  const sanitized = {
    ...urlParts,
    query: {
      ...urlParts.query
    }
  };

  // Only sanitize fields that need it
  if (sanitized.query.address) {
    if (!validateAddress(sanitized.query.address)) {
      throw new Error('Invalid address format');
    }
  }

  if (sanitized.query.time) {
    const time = parseInt(sanitized.query.time);
    if (isNaN(time)) throw new Error('Invalid time format');
    sanitized.query.time = time;
  }

  if (sanitized.query.email) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sanitized.query.email)) {
      throw new Error('Invalid email format');
    }
  }

  return sanitized;
}

module.exports = {
  validateAddress,
  sanitizeInput
};