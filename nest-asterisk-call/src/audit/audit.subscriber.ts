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

// Lista de entidades que NO queremos auditar.
const EXCLUDED_ENTITIES = [AuditLog, User];

@Injectable()
@EventSubscriber()
export class AuditSubscriber implements EntitySubscriberInterface<any> {
  constructor(
    private readonly dataSource: DataSource,
    private readonly requestContext: RequestContext, // Inyección de dependencias
  ) {
    // Registra este subscriber con la conexión de TypeORM
    dataSource.subscribers.push(this);
  }

  /**
   * Verifica si una entidad debe ser excluida de la auditoría.
   */
  private isExcluded(entity: any): boolean {
    if (!entity) return true;
    return EXCLUDED_ENTITIES.some(
      (excluded) => entity instanceof excluded || entity.constructor.name === excluded.name,
    );
  }

  /**
   * Se ejecuta después de que se inserta una nueva entidad.
   */
  async afterInsert(event: InsertEvent<any>) {
    if (this.isExcluded(event.entity)) {
      return;
    }

    const auditLog = new AuditLog();
    auditLog.action = AuditAction.CREATE;
    auditLog.entity = event.metadata.tableName;
    auditLog.entityId = event.entity.id;
    auditLog.newValues = event.entity;
    auditLog.user = this.requestContext.getUser(); // Obtiene el usuario del contexto

    await event.manager.save(auditLog);
  }

  /**
   * Se ejecuta después de que se actualiza una entidad.
   */
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

      // Compara si el valor realmente cambió para evitar logs innecesarios
      if (JSON.stringify(dbValue) !== JSON.stringify(entityValue)) {
        oldValues[colName] = dbValue;
        newValues[colName] = entityValue;
      }
    }

    // Si ninguna columna relevante cambió su valor, no se crea el log
    if (Object.keys(newValues).length === 0) {
      return;
    }

    const auditLog = new AuditLog();
    auditLog.action = AuditAction.UPDATE;
    auditLog.entity = event.metadata.tableName;
    auditLog.entityId = event.entity.id as string;
    auditLog.oldValues = oldValues;
    auditLog.newValues = newValues;
    auditLog.user = this.requestContext.getUser(); // Obtiene el usuario del contexto

    await event.manager.save(auditLog);
  }

  /**
   * Se ejecuta antes de que se elimine una entidad.
   */
  async beforeRemove(event: RemoveEvent<any>) {
    if (this.isExcluded(event.entity)) {
      return;
    }

    const auditLog = new AuditLog();
    auditLog.action = AuditAction.DELETE;
    auditLog.entity = event.metadata.tableName;
    auditLog.entityId = event.entity.id;
    auditLog.oldValues = event.entity; // Guarda el estado completo antes de borrar
    auditLog.user = this.requestContext.getUser(); // Obtiene el usuario del contexto

    // Se usa el queryRunner del evento para asegurar que se guarde en la misma transacción
    await event.queryRunner.manager.save(auditLog);
  }
}