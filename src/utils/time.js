function getNigerianTime() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Lagos' }));
}

function isWithinBusinessHours(vendor) {
  const now = getNigerianTime();
  const hour = now.getHours();
  const day = now.getDay();
  const hours = vendor.business_hours || { open: 8, close: 20, days: [1, 2, 3, 4, 5, 6] };
  return hours.days.includes(day) && hour >= hours.open && hour < hours.close;
}

module.exports = { getNigerianTime, isWithinBusinessHours };
