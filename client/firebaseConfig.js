const { initializeApp } = require("firebase/app");
const { getFirestore } = require("firebase/firestore");

// Placeholder config - User needs to replace this
const firebaseConfig = {
  apiKey: "AIzaSyBLmMcWkCGE0Ra8FuG0XYG7Oqg_Y7U1wT4",
  authDomain: "remote-server-99507.firebaseapp.com",
  projectId: "remote-server-99507",
  storageBucket: "remote-server-99507.firebasestorage.app",
  messagingSenderId: "795530967838",
  appId: "1:795530967838:web:ece1ba2d1292e3be2f270f"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

module.exports = { db };
