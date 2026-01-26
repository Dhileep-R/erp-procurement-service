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

/* ================== ENTITY ================== */

@Entity()
class PurchaseOrder {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  poNumber!: string;
}

/* ================== REDIS SERVICE ================== */

@Injectable()
class RedisService {
  private client = new Redis({
    host: '127.0.0.1',
    port: 6380,
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
    private readonly redis: RedisService,
  ) {}

  async create(poNumber: string): Promise<PurchaseOrder> {
    const po = await this.repo.save({ poNumber });
    await this.redis.set(`po:id:${po.id}`, po);
    return po;
  }

  async list(): Promise<PurchaseOrder[]> {
    return this.repo.find({ order: { id: 'DESC' } });
  }

  async getById(id: number): Promise<PurchaseOrder> {
    const po = await this.redis.get<PurchaseOrder>(`po:id:${id}`);
    if (!po) throw new Error('PO not found in Redis');
    return po;
  }

  async update(id: number, poNumber: string): Promise<PurchaseOrder> {
    await this.repo.update(id, { poNumber });
    const updated: PurchaseOrder = { id, poNumber };
    await this.redis.set(`po:id:${id}`, updated);
    return updated;
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
      secret: 'ERP_SECRET',
    }),
    TypeOrmModule.forRoot({
      type: 'mysql',
      host: 'localhost',
      port: 3306,
      username: 'root',
      password: 'Test123#',
      database: 'erp',
      entities: [PurchaseOrder],
      synchronize: true,
    }),
    TypeOrmModule.forFeature([PurchaseOrder]),
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
  await app.listen(3002);
  console.log('Procurement service running on port 3002');
}

bootstrap();
