"use server";
import Product from "@/lib/models/products.model";
import { connectToDB } from "@/lib/mongoose";
import { generateEmailBody, sendEmail } from "@/lib/nodeMailer";
import { scrapeAmazonProduct } from "@/lib/scraper";
import {
  getAveragePrice,
  getEmailNotifType,
  getHighestPrice,
  getLowestPrice,
} from "@/lib/scraper/utils";
import { NextResponse } from "next/server";

// const maxDuration = 1000 * 60 * 60 * 24; // 24 hours
const maxDuration = 1000 * 60 * 60; // 1 hour
const dynamic = "force-dynamic";
const revalidate = 0;
const MAX_RETRIES = 3;
const INITIAL_DELAY = 1000; // 1 second

export async function GET() {
  try {
    await connectToDB();
    const products = await Product.find({});
    if (!products || products.length === 0)
      throw new Error("No products found");

    const updatedProducts = [];
    for (const current of products) {
      try {
        const scrapedProduct = await scrapeAmazonProduct(current.url);
        if (!scrapedProduct) {
          continue;
        }
        if (
          scrapedProduct.currentPrice == null ||
          scrapedProduct.currentPrice == 0
        ) {
          const newProduct = {
            ...scrapedProduct,

            isOutOfStock: true,
          };
          const updatedProduct = await Product.findOneAndUpdate(
            { url: newProduct.url },
            newProduct,
            { new: true }
          );
          updatedProducts.push(updatedProduct);
        } else {
          const updatedPriceHistory = [
            ...current.priceHistory,
            {
              price: scrapedProduct.currentPrice,
            },
          ];

          const newProduct = {
            ...scrapedProduct,
            currentPrice: scrapedProduct.currentPrice,
            priceHistory: updatedPriceHistory,
            lowestPrice: getLowestPrice(updatedPriceHistory),
            highestPrice: getHighestPrice(updatedPriceHistory),
            averagePrice: getAveragePrice(updatedPriceHistory),
            isOutOfStock: scrapedProduct.isOutOfStock,
          };
          const updatedProduct = await Product.findOneAndUpdate(
            { url: newProduct.url },
            newProduct,
            { new: true }
          );

          //Check item status & send email
          const emailNotify = getEmailNotifType(scrapedProduct, current);
          if (
            emailNotify &&
            updatedProduct.users &&
            updatedProduct.users.length > 0
          ) {
            const productInfo = {
              title: updatedProduct.title,
              url: updatedProduct.url,
              currentPrice: updatedProduct.currentPrice,
            };
            const emailContent = await generateEmailBody(
              productInfo,
              emailNotify
            );
            const userEmails = updatedProduct.users.map(
              (user: any) => user.email
            );
            await sendEmail(
              userEmails,
              emailContent.subject,
              emailContent.body
            );
          }
          updatedProducts.push(updatedProduct);
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      } catch (error) {
        console.error(`Error processing ${current.url}:`, error);
        continue; // Continue to the next product on error
      }
    }

    const filteredProducts = updatedProducts.filter(
      (product) => product !== null
    );

    return NextResponse.json({
      message: "OK",
      data: filteredProducts,
    });
  } catch (error: any) {
    console.error(`Error in GET cron job: ${error} `);
    return NextResponse.json(
      {
        message: "Error",
        error: error,
      },
      { status: 500 }
    );
  }
}
