import {
  EventSubscriber,
  EntitySubscriberInterface,
  InsertEvent,
  UpdateEvent,
  RemoveEvent,
  DataSource,
} from 'typeorm';
import { Injectable } from '@nestjs/common';
import { AuditLog, AuditAction } from './audit.entity';
import { RequestContext } from '../core/request-context.service';
import { User } from '../user/user.entity';

const EXCLUDED_ENTITIES = [AuditLog, User];

const MAX_AUDIT_LOGS_PER_ENTITY = 100;

@Injectable()
@EventSubscriber()
export class AuditSubscriber implements EntitySubscriberInterface<any> {
  private auditQueue: AuditLog[] = [];
  private flushTimeout: NodeJS.Timeout | null = null;
  private readonly BATCH_SIZE = 50;
  private readonly FLUSH_INTERVAL = 5000;

  constructor(
    private readonly dataSource: DataSource,
    private readonly requestContext: RequestContext,
  ) {
    dataSource.subscribers.push(this);
    this.startPeriodicFlush();
  }

  private startPeriodicFlush(): void {
    setInterval(() => {
      this.flushAuditQueue().catch(err => {
        console.error('Error flushing audit queue:', err);
      });
    }, this.FLUSH_INTERVAL);
  }

  private async flushAuditQueue(): Promise<void> {
    if (this.auditQueue.length === 0) return;

    const toSave = this.auditQueue.splice(0, this.BATCH_SIZE);
    
    try {
      await this.dataSource.manager.save(AuditLog, toSave, { chunk: 50 });
    } catch (err) {
      console.error('Error saving audit logs batch:', err);
    }
  }

  private isExcluded(entity: any): boolean {
    if (!entity) return true;
    return EXCLUDED_ENTITIES.some(
      (excluded) => entity instanceof excluded || entity.constructor.name === excluded.name,
    );
  }

  async afterInsert(event: InsertEvent<any>) {
    if (this.isExcluded(event.entity)) {
      return;
    }

    const auditLog = new AuditLog();
    auditLog.action = AuditAction.CREATE;
    auditLog.entity = event.metadata.tableName;
    auditLog.entityId = event.entity.id;
    auditLog.newValues = this.sanitizeValues(event.entity);
    auditLog.user = this.requestContext.getUser();

    this.auditQueue.push(auditLog);

    if (this.auditQueue.length >= this.BATCH_SIZE) {
      await this.flushAuditQueue();
    }
  }

  async afterUpdate(event: UpdateEvent<any>) {
    if (this.isExcluded(event.entity)) {
      return;
    }

    const updatedColumns = event.updatedColumns.map((col) => col.databaseName);
    const oldValues: Record<string, any> = {};
    const newValues: Record<string, any> = {};

    for (const colName of updatedColumns) {
      const dbValue = event.databaseEntity[colName];
      const entityValue = event.entity[colName];

      if (JSON.stringify(dbValue) !== JSON.stringify(entityValue)) {
        oldValues[colName] = dbValue;
        newValues[colName] = entityValue;
      }
    }

    if (Object.keys(newValues).length === 0) {
      return;
    }

    const auditLog = new AuditLog();
    auditLog.action = AuditAction.UPDATE;
    auditLog.entity = event.metadata.tableName;
    auditLog.entityId = event.entity.id as string;
    auditLog.oldValues = this.sanitizeValues(oldValues);
    auditLog.newValues = this.sanitizeValues(newValues);
    auditLog.user = this.requestContext.getUser();

    this.auditQueue.push(auditLog);

    if (this.auditQueue.length >= this.BATCH_SIZE) {
      await this.flushAuditQueue();
    }
  }

  async beforeRemove(event: RemoveEvent<any>) {
    if (this.isExcluded(event.entity)) {
      return;
    }

    const auditLog = new AuditLog();
    auditLog.action = AuditAction.DELETE;
    auditLog.entity = event.metadata.tableName;
    auditLog.entityId = event.entity.id;
    auditLog.oldValues = this.sanitizeValues(event.entity);
    auditLog.user = this.requestContext.getUser();

    await event.queryRunner.manager.save(auditLog);
  }

  private sanitizeValues(values: any): any {
    if (!values || typeof values !== 'object') {
      return values;
    }

    const sanitized = { ...values };
    const sensitiveFields = ['password', 'token', 'secret', 'currentToken', 'apiKey'];

    for (const field of sensitiveFields) {
      if (field in sanitized) {
        sanitized[field] = '[REDACTED]';
      }
    }

    if (sanitized.message && typeof sanitized.message === 'string' && sanitized.message.length > 500) {
      sanitized.message = sanitized.message.substring(0, 500) + '...';
    }

    return sanitized;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.flushAuditQueue();
  }
}