const { lstatSync } = require("fs");

module.exports = {
  "*.{ts,tsx,js,jsx,json,md}": (files) => {
    const realFiles = files.filter((f) => !lstatSync(f).isSymbolicLink());
    return realFiles.length > 0
      ? [`prettier --write ${realFiles.map((f) => `"${f}"`).join(" ")}`]
      : [];
  },
};
