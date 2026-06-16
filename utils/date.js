const MS_PER_DAY = 86400000;

function startOfDay(d = new Date())  { const x = new Date(d); x.setHours(0,0,0,0); return x; }
function endOfDay(d   = new Date())  { const x = new Date(d); x.setHours(23,59,59,999); return x; }
function addDays(d, n)               { return new Date(d.getTime() + n * MS_PER_DAY); }
function daysBetween(a, b)           { return Math.round((startOfDay(b) - startOfDay(a)) / MS_PER_DAY); }

module.exports = { startOfDay, endOfDay, addDays, daysBetween };
