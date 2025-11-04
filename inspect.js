const fs = require('fs');

const lines = fs.readFileSync('renderer/index.html', 'utf8').split(/\r?\n/);
lines.forEach((line, idx) => {
  if (line.includes('Р')) {
    console.log(idx, line.trim());
  }
});
