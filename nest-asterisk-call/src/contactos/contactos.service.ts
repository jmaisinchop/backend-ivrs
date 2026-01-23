import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/typeorm';
import { Connection } from 'typeorm';
import dayjs from 'dayjs';

@Injectable()
export class ContactosService {
    constructor(
        @InjectConnection('contactos')
        private readonly connection: Connection,
    ) { }

    async obtenerPadresNiveles(): Promise<any[]> {
        const sql = `
      WITH padres AS (
          SELECT
              CASE
                  WHEN UPPER(ccc.descripcion) LIKE '%PROPIA%' THEN 
                      TRIM(REGEXP_REPLACE(ccc.descripcion, '\\s+[0-9]+$', '', 'g'))
                  ELSE 
                      ccc.nombre
              END AS padre_normalizado,
              ccc.id,
              ccc.tipocartera
          FROM 
              cb_car_cartera ccc
          WHERE 
              ccc.estado = 0
      ),
      niveles_raw AS (
          SELECT 
              p.padre_normalizado,
              UPPER(c.nivelcartera) AS nivelcartera,
              p.tipocartera
          FROM 
              contratocobranza c
          INNER JOIN 
              padres p ON c.carteracb_id = p.id
          WHERE 
              c.cubre = false
      ),
      niveles_procesados AS (
          SELECT 
              padre_normalizado,
              tipocartera,
              nivelcartera
          FROM 
              niveles_raw
          GROUP BY 
              padre_normalizado, tipocartera, nivelcartera
      )
      SELECT 
          np.padre_normalizado AS padre,
          CASE 
              WHEN np.tipocartera = 1 THEN (
                  SELECT STRING_AGG(DISTINCT nivelcartera, ', ' ORDER BY nivelcartera)
                  FROM niveles_procesados sub
                  WHERE sub.padre_normalizado = np.padre_normalizado
              )
              ELSE np.nivelcartera
          END AS niveles_concatenados,
          CASE 
              WHEN np.tipocartera = 1 THEN true
              ELSE false
          END AS es_propia
      FROM 
          niveles_procesados np
      ORDER BY 
          np.padre_normalizado;
    `;

        const rawResult = await this.connection.query(sql);

        const vistos = new Set<string>();
        const resultadoFinal = [];

        for (const row of rawResult) {
            const nivelesUnicos = Array.from(
                new Set(
                    (row.niveles_concatenados || '')
                        .split(',')
                        .map((n: string) => n.trim())
                        .filter(n => n.length > 0)
                )
            ).join(', ');

            const claveUnica = `${row.padre}|${nivelesUnicos}|${row.es_propia}`;

            if (!vistos.has(claveUnica)) {
                vistos.add(claveUnica);
                resultadoFinal.push({
                    padre: row.padre,
                    niveles_concatenados: nivelesUnicos,
                    es_propia: row.es_propia,
                });
            }
        }

        return resultadoFinal;
    }

    async obtenerContactosPorNivel(niveles: string, esPropia: boolean): Promise<any[]> {
        if (!niveles || typeof niveles !== 'string') {
            throw new Error('Parámetro niveles inválido');
        }

        const nivelesArray = niveles.split(',').map(n => n.trim()).filter(n => n.length > 0);
        
        if (nivelesArray.length === 0) {
            throw new Error('No se proporcionaron niveles válidos');
        }

        if (nivelesArray.length > 50) {
            throw new Error('Demasiados niveles proporcionados (máximo 50)');
        }

        const fechaActual = dayjs().format('MM-YYYY');
        
        const whereConditions = nivelesArray.map((_, index) => `c.nivelcartera LIKE $${index + 1}`).join(' OR ');
        const parameters = nivelesArray.map(nivel => `%${nivel}%`);

        const nextParamIndex = parameters.length + 1;

        let sql = '';
        
        if (esPropia) {
            sql = `
            SELECT 
              ccc.cedula, 
              ccc.nombre, 
              d.valorpagado, 
              ccnc.numero
            FROM 
              contratocobranza c
            JOIN 
              cb_car_cliente_contratocobranza cccc 
              ON cccc.listacontratocobranza_id = c.id
            JOIN 
              cb_car_cliente ccc 
              ON ccc.id = cccc.cb_car_cliente_id
            JOIN 
              contratocobranza_datoscobranza cd 
              ON cd.contratocobranza_id = c.id 
            JOIN 
              datoscobranza d 
              ON cd.datoscobranzas_id = d.id
            JOIN 
              cb_car_cliente_cb_car_numero_contacto cccccnc 
              ON ccc.id = cccccnc.cb_car_cliente_id
            JOIN 
              cb_car_numero_contacto ccnc 
              ON ccnc.id = cccccnc.numeroscontacto_id
            WHERE 
              c.cubre = false 
              AND (${whereConditions})
              AND ccnc.valido = true 
              AND (c.observaciones IS NULL OR c.observaciones = '') 
              AND c.fechafinalizacion IS NULL
              AND ccnc.tiponumero LIKE UPPER('%TITULAR%')
            LIMIT 100000
          `;
        } else {
            sql = `
            SELECT 
              ccc.cedula, 
              ccc.nombre, 
              d.valorpagado, 
              ccnc.numero
            FROM 
              contratocobranza c
            JOIN 
              cb_car_cliente_contratocobranza cccc 
              ON cccc.listacontratocobranza_id = c.id
            JOIN 
              cb_car_cliente ccc 
              ON ccc.id = cccc.cb_car_cliente_id
            JOIN 
              contratocobranza_datoscobranza cd 
              ON cd.contratocobranza_id = c.id 
            JOIN 
              datoscobranza d 
              ON cd.datoscobranzas_id = d.id
            JOIN 
              cb_car_cliente_cb_car_numero_contacto cccccnc 
              ON ccc.id = cccccnc.cb_car_cliente_id
            JOIN 
              cb_car_numero_contacto ccnc 
              ON ccnc.id = cccccnc.numeroscontacto_id
            WHERE 
              c.cubre = false 
              AND (${whereConditions})
              AND ccnc.valido = true 
              AND ccnc.tiponumero LIKE UPPER('%TITULAR%')
              AND c.fechacreacion LIKE $${nextParamIndex}
            LIMIT 100000
          `;
          parameters.push(`%${fechaActual}%`);
        }

        try {
            const result = await this.connection.query(sql, parameters);
            return result;
        } catch (error) {
            throw new Error(`Error ejecutando consulta de contactos: ${error.message}`);
        }
    }
}