console.log("argv[1]:", process.argv[1]);
console.log("import.meta.url:", import.meta.url);
console.log("match:", import.meta.url === `file://${process.argv[1]}`);
