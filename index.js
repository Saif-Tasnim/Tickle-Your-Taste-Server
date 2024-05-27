const express = require("express");
const cors = require("cors");
require("dotenv").config();
const jwt = require("jsonwebtoken");
const port = process.env.PORT || 5000;
const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const app = express();

// middleware
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Recipe server is opened");
});

// verify JWT
const verifyJWT = (req, res, next) => {
  const authorization = req.headers.authorization;

  if (!authorization) {
    return res
      .status(401)
      .send({ error: true, message: "unauthorized access" });
  }

  // it will carry bearer token thats why it has to split
  const token = authorization.split(" ")[1];

  jwt.verify(token, process.env.JSON_SECRET_KEY, (err, decoded) => {
    if (err) {
      return res
        .status(401)
        .send({ error: true, message: "unauthorized access" });
    }

    req.decoded = decoded;
    next();
  });
};

app.post("/jwt", (req, res) => {
  const user = req.body;
  const token = jwt.sign(user, process.env.JSON_SECRET_KEY, {
    expiresIn: "1h",
  });
  res.send({ token });
});

const uri = `mongodb+srv://${process.env.DB_NAME}:${process.env.DB_PASS}@cluster0.ectfhk2.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();
    const userCollection = client.db("RecipeHouse").collection("users");
    const recipeCollection = client.db("RecipeHouse").collection("recipe");
    const paymentCollection = client.db("RecipeHouse").collection("payment");

    app.get("/users/:email", verifyJWT, async (req, res) => {
      const query = { email: req.params.email };
      const { email } = req.decoded;

      if (email !== req.params.email) {
        return res.status(401).json({ message: "Unauthorized Access" });
      }

      const data = await userCollection.findOne(query);
      if (!data) {
        return res.status(401).json({ message: "Unauthorized Access" });
      }
      res.send(data);
    });

    app.get("/creator-users/:email", verifyJWT, async (req, res) => {
      const query = { email: req.params.email };

      const data = await userCollection.findOne(query, {
        projection: {
          email: 1,
          coins: 1,
        },
      });
      if (!data) {
        return res.status(404).json({ message: "Users Not Found" });
      }
      res.send(data);
    });

    app.post("/store-user", async (req, res) => {
      const body = req.body;
      const query = { email: body.email };
      const found = await userCollection.findOne(query);
      if (found) {
        return res.send("user already exist");
      }
      const result = await userCollection.insertOne(body);
      res.send(result);
    });

    app.get("/get-recipe", async (req, res) => {
      const result = await recipeCollection
        .find(
          {},
          {
            projection: {
              recipeName: 1,
              recipeImage: 1,
              purchasedBy: 1,
              creatorEmail: 1,
              countryName: 1,
              watchCount: 1,
            },
          }
        )
        .toArray();
      res.send(result);
    });

    app.get("/get-recipe/:id", verifyJWT,  async (req, res) => {
      const { id } = req.params;
      const result = await recipeCollection.findOne({ _id: new ObjectId(id) });
      res.send(result);
    });

    app.post("/recipe-store", verifyJWT, async (req, res) => {
      const data = req.body;
      const { email } = req.decoded;
      if (email !== data.creatorEmail) {
        return res.status(401).json({ message: "Unauthorized access" });
      }
      const result = await recipeCollection.insertOne(data);
      res.send(result);
    });

    app.patch("/update-recipe", verifyJWT, async (req, res) => {
      const { newUserData, newCreatorData, newRecipeData } = req.body;
      const userId = new ObjectId(newUserData._id);
      const creatorId = new ObjectId(newCreatorData._id);
      const recipeId = new ObjectId(newRecipeData._id);

      delete newUserData._id;
      delete newCreatorData._id;
      delete newRecipeData._id;

      const userQuery = { _id: userId };
      const creatorQuery = { _id: creatorId };
      const recipeQuery = { _id: recipeId };

      const updateUserInfo = {
        $set: {
          ...newUserData,
        },
      };
      const updateCreatorInfo = {
        $set: {
          ...newCreatorData,
        },
      };
      const updateRecipeInfo = {
        $set: {
          ...newRecipeData,
        },
      };

      try {
        const updateUserRes = await userCollection.updateOne(
          userQuery,
          updateUserInfo
        );
        const updateCreatorRes = await userCollection.updateOne(
          creatorQuery,
          updateCreatorInfo
        );
        const updateRecipeRes = await recipeCollection.updateOne(
          recipeQuery,
          updateRecipeInfo
        );

        if (
          updateUserRes.modifiedCount > 0 &&
          updateCreatorRes.modifiedCount > 0 &&
          updateRecipeRes.modifiedCount > 0
        ) {
          return res.send({
            message: "Update successful",
            updateUserRes,
            updateCreatorRes,
            updateRecipeRes,
          });
        } else {
          return res.status(400).json({ message: "No records were updated" });
        }
      } catch (error) {
        console.error("Error updating records:", error);
        return res
          .status(500)
          .json({ message: "Something went wrong. Try again.", error });
      }
    });

    // payment gateway
    app.post("/create-payment-intent", verifyJWT, async (req, res) => {
      const { price } = req.body;
      const amount = parseFloat(price) * 100;
      const paymentIntent = await stripe.paymentIntents.create({
        amount: amount,
        currency: "usd",
        payment_method_types: ["card"],
      });

      res.send({
        clientSecret: paymentIntent.client_secret,
      });
    });

    app.post("/payment", verifyJWT, async (req, res) => {
      const body = req.body;
      const { email, amount } = body;
      const query = { email: email };
      const price = parseInt(amount);

      const updateData = {
        $set: {
          coins: price === 1 ? 100 : amount == 5 ? 500 : 1000,
        },
      };
      const result = await userCollection.updateOne(query, updateData);
      if (result.modifiedCount > 0) {
        const store = await paymentCollection.insertOne(body);
        res.send(store);
      } else {
        res.status(500).json({ message: "Internal Error. Try again" });
      }
    });

    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.listen(port, () => {
  console.log(`${port} is set for recipe server`);
});
