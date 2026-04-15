import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import {
  Module,
  Controller,
  Post,
  Get,
  Put,
  Body,
  Param,
  Injectable,
  UnauthorizedException,
  CanActivate,
  ExecutionContext,
} from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Repository,
} from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import Redis from 'ioredis';
import { ManyToOne, JoinColumn } from 'typeorm';
import * as dotenv from 'dotenv';
dotenv.config();

/* ================== ENTITY ================== */

@Entity()
class PurchaseOrder {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  poNumber!: string;
}

@Entity()
class PoLineItem {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  poId!: number;

  @Column()
  count!: number;

  @ManyToOne(() => PurchaseOrder, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'poId' })
  po!: PurchaseOrder;
}

/* ================== REDIS SERVICE ================== */

@Injectable()
class RedisService {
  private client = new Redis({
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT),
  });

  async set(key: string, value: unknown): Promise<void> {
    console.log('Redis SET:', key, '=>', value);
    await this.client.set(key, JSON.stringify(value));
  }

  async get<T>(key: string): Promise<T | null> {
    const data = await this.client.get(key);
    console.log('Redis GET:', key, '=>', data);
    return data ? (JSON.parse(data) as T) : null;
  }
}

/* ================== GLOBAL JWT AUTH GUARD ================== */

@Injectable()
class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const authHeader: string | undefined =
      request.headers?.authorization;

    if (!authHeader) {
      throw new UnauthorizedException('Missing Authorization header');
    }

    const token = authHeader.replace('Bearer ', '');

    try {
      request.user = this.jwt.verify(token);
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}

/* ================== SERVICE ================== */

@Injectable()
class PoService {
  constructor(
    @InjectRepository(PurchaseOrder)
  private readonly repo: Repository<PurchaseOrder>,

  @InjectRepository(PoLineItem)
  private readonly lineRepo: Repository<PoLineItem>,

  private readonly redis: RedisService,
  ) {}

  async create(poNumber: string): Promise<PurchaseOrder> {
    const po = await this.repo.save({ poNumber });

  // 2️⃣ Create line items
  const lineItems = await this.lineRepo.save([
    { poId: po.id, count: 1 },
    { poId: po.id, count: 2 },
  ]);

  const response = {
    ...po,
    lineItems,
  };

  // 3️⃣ Cache
  await this.redis.set(`po:id:${po.id}`, response);

  return response;
  }

  async list(): Promise<PurchaseOrder[]> {
    return this.repo.find({ order: { id: 'DESC' } });
  }

  async getById(id: number): Promise<PurchaseOrder> {
    const cacheKey = `po:id:${id}`;

  // 1️⃣ Try Redis
  const cached = await this.redis.get<any>(cacheKey);
  if (cached) {
    console.log('✅ Cache HIT');
    return cached;
  }

  console.log('❌ Cache MISS → DB');

  // 2️⃣ Fetch PO
  const po = await this.repo.findOne({ where: { id } });
  if (!po) throw new Error('PO not found');

  // 3️⃣ Fetch line items
  const lineItems = await this.lineRepo.find({
    where: { poId: id },
  });

  const response = {
    ...po,
    lineItems,
  };

  // 4️⃣ Cache again
  await this.redis.set(cacheKey, response);

  return response;
  }

  async update(id: number, poNumber: string): Promise<PurchaseOrder> {
    await this.repo.update(id, { poNumber });

  const po = await this.repo.findOne({ where: { id } });

  const lineItems = await this.lineRepo.find({
    where: { poId: id },
  });

  const response = {
    ...po,
    lineItems,
  };

  await this.redis.set(`po:id:${id}`, response);

  return response;
  }
}

/* ================== CONTROLLER ================== */

@Controller('po')
class PoController {
  constructor(private readonly po: PoService) {}

  @Post()
  create(@Body() body: { poNumber: string }) {
    return this.po.create(body.poNumber);
  }

  @Get()
  list() {
    return this.po.list();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.po.getById(Number(id));
  }

  @Put(':id')
  update(
    @Param('id') id: string,
    @Body() body: { poNumber: string },
  ) {
    return this.po.update(Number(id), body.poNumber);
  }
}

/* ================== MODULE ================== */

@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_SECRET,
      signOptions: { expiresIn: '1h' },
    }),
    TypeOrmModule.forRoot({
      type: 'mysql',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      username: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      entities: [PurchaseOrder, PoLineItem],
      synchronize: true,
    }),
    TypeOrmModule.forFeature([PurchaseOrder, PoLineItem]),
  ],
  controllers: [PoController],
  providers: [
    PoService,
    RedisService,
    JwtAuthGuard,
  ],
})
class AppModule {}

/* ================== BOOTSTRAP ================== */

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // 🔐 APPLY JWT GUARD GLOBALLY
  app.useGlobalGuards(
    app.get(JwtAuthGuard),
  );

  app.enableCors();
  await app.listen(process.env.PORT);
  console.log(`Procurement service running on port ${process.env.PORT}`);
}

bootstrap();
