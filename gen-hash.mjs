import bcrypt from "bcrypt";

const run = async () => {
  const adminPass = "Jeckilfigo2!";        // <-- cambia
  const opPass = "cantinota26";       // <-- cambia

  const adminHash = await bcrypt.hash(adminPass, 10);
  const opHash = await bcrypt.hash(opPass, 10);

  console.log("ADMIN HASH:", adminHash);
  console.log("OPERATORE HASH:", opHash);
};

run();
