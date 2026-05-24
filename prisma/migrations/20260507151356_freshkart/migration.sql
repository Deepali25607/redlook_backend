-- CreateTable
CREATE TABLE "Customer" (
    "customer_id" TEXT NOT NULL,
    "full_name" VARCHAR(100) NOT NULL,
    "email" VARCHAR(150) NOT NULL,
    "phone" VARCHAR(15) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "date_of_birth" DATE,
    "gender" VARCHAR(10),
    "profile_picture_url" VARCHAR(500),
    "loyalty_points" INTEGER NOT NULL DEFAULT 0,
    "account_status" VARCHAR(20) NOT NULL DEFAULT 'Active',
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "phone_verified" BOOLEAN NOT NULL DEFAULT false,
    "notification_prefs" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_login" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("customer_id")
);

-- CreateTable
CREATE TABLE "Session" (
    "token" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("token")
);

-- CreateTable
CREATE TABLE "Address" (
    "address_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "label" VARCHAR(20) NOT NULL,
    "recipient_name" VARCHAR(100) NOT NULL,
    "recipient_phone" VARCHAR(15) NOT NULL,
    "address_line1" VARCHAR(255) NOT NULL,
    "address_line2" VARCHAR(255),
    "landmark" VARCHAR(100),
    "city" VARCHAR(50) NOT NULL,
    "state" VARCHAR(50) NOT NULL,
    "pincode" VARCHAR(6) NOT NULL,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "is_default" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Address_pkey" PRIMARY KEY ("address_id")
);

-- CreateTable
CREATE TABLE "Category" (
    "category_id" TEXT NOT NULL,
    "name" VARCHAR(50) NOT NULL,
    "icon" VARCHAR(10) NOT NULL,
    "parent_category_id" TEXT,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("category_id")
);

-- CreateTable
CREATE TABLE "Product" (
    "product_id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "category_id" TEXT NOT NULL,
    "description" TEXT,
    "price_per_unit" DECIMAL(10,2) NOT NULL,
    "unit" VARCHAR(10) NOT NULL,
    "stock_quantity" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "is_organic" BOOLEAN NOT NULL DEFAULT false,
    "image" VARCHAR(500) NOT NULL,
    "rating" DECIMAL(3,2) NOT NULL DEFAULT 0,
    "reviews_count" INTEGER NOT NULL DEFAULT 0,
    "freshness" VARCHAR(50),
    "status" VARCHAR(20) NOT NULL DEFAULT 'Active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("product_id")
);

-- CreateTable
CREATE TABLE "Order" (
    "order_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "address_snapshot" JSONB NOT NULL,
    "order_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivery_slot" VARCHAR(50) NOT NULL,
    "subtotal" DECIMAL(10,2) NOT NULL,
    "discount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "delivery_charge" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "tax" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "total_amount" DECIMAL(10,2) NOT NULL,
    "payment_method" VARCHAR(20) NOT NULL,
    "payment_status" VARCHAR(20) NOT NULL DEFAULT 'Pending',
    "order_status" VARCHAR(20) NOT NULL DEFAULT 'Placed',
    "timeline" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "Order_pkey" PRIMARY KEY ("order_id")
);

-- CreateTable
CREATE TABLE "OrderItem" (
    "order_item_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "image" VARCHAR(500) NOT NULL,
    "unit" VARCHAR(10) NOT NULL,
    "quantity" DECIMAL(10,2) NOT NULL,
    "unit_price" DECIMAL(10,2) NOT NULL,
    "line_total" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("order_item_id")
);

-- CreateTable
CREATE TABLE "Cart" (
    "cart_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Cart_pkey" PRIMARY KEY ("cart_id")
);

-- CreateTable
CREATE TABLE "CartItem" (
    "cart_item_id" TEXT NOT NULL,
    "cart_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "qty" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "CartItem_pkey" PRIMARY KEY ("cart_item_id")
);

-- CreateTable
CREATE TABLE "WishlistItem" (
    "customer_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WishlistItem_pkey" PRIMARY KEY ("customer_id","product_id")
);

-- CreateTable
CREATE TABLE "Review" (
    "review_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("review_id")
);

-- CreateTable
CREATE TABLE "Coupon" (
    "coupon_id" TEXT NOT NULL,
    "code" VARCHAR(30) NOT NULL,
    "type" VARCHAR(20) NOT NULL,
    "value" DECIMAL(10,2) NOT NULL,
    "min_order" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "max_uses" INTEGER,
    "used_count" INTEGER NOT NULL DEFAULT 0,
    "valid_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "valid_until" TIMESTAMP(3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Coupon_pkey" PRIMARY KEY ("coupon_id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "audit_id" TEXT NOT NULL,
    "customer_id" TEXT,
    "action" VARCHAR(100) NOT NULL,
    "meta" JSONB,
    "ip" VARCHAR(45),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("audit_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Customer_email_key" ON "Customer"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_phone_key" ON "Customer"("phone");

-- CreateIndex
CREATE INDEX "Address_customer_id_idx" ON "Address"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "Category_name_key" ON "Category"("name");

-- CreateIndex
CREATE INDEX "Product_category_id_idx" ON "Product"("category_id");

-- CreateIndex
CREATE INDEX "Product_status_idx" ON "Product"("status");

-- CreateIndex
CREATE INDEX "Order_customer_id_idx" ON "Order"("customer_id");

-- CreateIndex
CREATE INDEX "Order_order_status_idx" ON "Order"("order_status");

-- CreateIndex
CREATE INDEX "OrderItem_order_id_idx" ON "OrderItem"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "Cart_customer_id_key" ON "Cart"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "CartItem_cart_id_product_id_key" ON "CartItem"("cart_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "Review_product_id_customer_id_key" ON "Review"("product_id", "customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "Coupon_code_key" ON "Coupon"("code");

-- CreateIndex
CREATE INDEX "AuditLog_customer_id_idx" ON "AuditLog"("customer_id");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "Customer"("customer_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Address" ADD CONSTRAINT "Address_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "Customer"("customer_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "Category"("category_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "Customer"("customer_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "Order"("order_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "Product"("product_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cart" ADD CONSTRAINT "Cart_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "Customer"("customer_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_cart_id_fkey" FOREIGN KEY ("cart_id") REFERENCES "Cart"("cart_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "Product"("product_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WishlistItem" ADD CONSTRAINT "WishlistItem_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "Customer"("customer_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WishlistItem" ADD CONSTRAINT "WishlistItem_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "Product"("product_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "Product"("product_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "Customer"("customer_id") ON DELETE RESTRICT ON UPDATE CASCADE;
