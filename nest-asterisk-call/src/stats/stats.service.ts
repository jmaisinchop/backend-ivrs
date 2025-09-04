import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, LessThan } from 'typeorm';
import { Campaign } from '../campaign/campaign.entity';
import { Contact } from '../campaign/contact.entity';
import { ChannelLimit } from '../channel-limit/channel-limit.entity';
import * as ExcelJS from 'exceljs';
import { WhatsappCampaign } from '../whatsapp-campaign/whatsapp-campaign.entity';
import { WhatsappContact } from '../whatsapp-campaign/whatsapp-contact.entity';

@Injectable()
export class StatsService {
  constructor(
    @InjectRepository(Campaign) private campRepo: Repository<Campaign>,
    @InjectRepository(Contact) private contactRepo: Repository<Contact>,
    @InjectRepository(ChannelLimit) private limitRepo: Repository<ChannelLimit>,
    @InjectRepository(WhatsappCampaign) private whatsappCampRepo: Repository<WhatsappCampaign>,
    @InjectRepository(WhatsappContact) private whatsappContactRepo: Repository<WhatsappContact>,
  ) { }

  // --- 👇 FUNCIÓN AUXILIAR CORREGIDA 👇 ---
  private async getIvrMetricsForPeriod(days: number, offsetDays: number, userId?: string) {
    const userFilter = userId ? `AND c."createdBy"::uuid = $3::uuid` : '';
    const params: any[] = [days, offsetDays];
    if (userId) params.push(userId);
    
    // ✅ CORRECCIÓN: Se añade ::integer para especificar el tipo de dato en la operación de suma.
    const query = `
      SELECT
        COUNT(DISTINCT CASE WHEN c.status IN ('RUNNING', 'PAUSED') THEN c.id END)::INT AS "activeCampaigns",
        COUNT(CASE WHEN ct."callStatus" = 'CALLING' THEN 1 END)::INT AS "ongoingCalls",
        COALESCE(
          COUNT(CASE WHEN ct."callStatus" = 'SUCCESS' THEN 1 END)::DECIMAL / 
          NULLIF(COUNT(CASE WHEN ct."callStatus" IN ('SUCCESS', 'FAILED') THEN 1 END), 0), 0
        ) AS "successRate"
      FROM campaign c
      LEFT JOIN contact ct ON ct."campaignId" = c.id
      WHERE c."startDate" BETWEEN NOW() - (($2::integer + $1::integer) * INTERVAL '1 day') AND NOW() - ($2::integer * INTERVAL '1 day')
      ${userFilter.replace('$3', `$${params.length}`)}
    `;

    const [result] = await this.campRepo.query(query, params);
    
    return {
      activeCampaigns: result ? +result.activeCampaigns : 0,
      ongoingCalls: result ? +result.ongoingCalls : 0,
      successRate: result ? +result.successRate : 0
    };
  }
  // --- FIN DE LA CORRECCIÓN ---


  /* --------------------------------------------------------- *
   * HELPERS
   * --------------------------------------------------------- */
  /** añade filtro por creador casteando AMBOS lados a uuid */
  private createdBy(idx: number) {
    return `AND c."createdBy"::uuid = $${idx}::uuid`;
  }
  /** ⇢ compara el createdBy convirtiendo la columna a texto   */
  private createdByTxt(idx: number) {
    /* columna uuid → text   |   $idx sigue siendo texto  */
    return `AND c."createdBy"::text = $${idx}`;
  }


  /* --------------------------------------------------------- *
   * SERIES BÁSICAS
   * --------------------------------------------------------- */
  getCallsPerDay(days = 30, userId?: string) {
    const extra = userId ? this.createdBy(2) : '';
    const params: (number | string)[] = [days];
    if (userId) params.push(userId);

    return this.contactRepo.query(
      `
      SELECT TO_CHAR(c."startDate",'YYYY-MM-DD')                AS day,
             COUNT(*)::INT                                     AS llamadas,
             COUNT(*) FILTER (WHERE ct."callStatus"='SUCCESS')::INT AS exitosas
      FROM contact ct
      JOIN campaign c ON c.id = ct."campaignId"
      WHERE c."startDate" >= NOW() - ($1 * INTERVAL '1 day')
        ${extra}
      GROUP BY 1
      ORDER BY 1;
      `,
      params,
    );
  }

  getCallsPerMonth(months = 12, userId?: string) {
    const extra = userId ? this.createdBy(2) : '';
    const params: (number | string)[] = [months];
    if (userId) params.push(userId);

    return this.contactRepo.query(
      `
      SELECT TO_CHAR(c."startDate",'YYYY-MM')                  AS month,
             COUNT(*)::INT                                    AS llamadas,
             COUNT(*) FILTER (WHERE ct."callStatus"='SUCCESS')::INT AS exitosas
      FROM contact ct
      JOIN campaign c ON c.id = ct."campaignId"
      WHERE c."startDate" >= DATE_TRUNC('month',NOW()) - ($1 * INTERVAL '1 month')
        ${extra}
      GROUP BY 1
      ORDER BY 1;
      `,
      params,
    );
  }

  getCallsPerHour(days = 7, userId?: string) {
    const extra = userId ? this.createdBy(2) : '';
    const params: (number | string)[] = [days];
    if (userId) params.push(userId);

    return this.contactRepo.query(
      `
      SELECT EXTRACT(HOUR FROM c."startDate")::INT              AS hour,
             COUNT(*)::INT                                     AS llamadas,
             COUNT(*) FILTER (WHERE ct."callStatus"='SUCCESS')::INT AS exitosas
      FROM contact ct
      JOIN campaign c ON c.id = ct."campaignId"
      WHERE c."startDate" >= NOW() - ($1 * INTERVAL '1 day')
        ${extra}
      GROUP BY 1
      ORDER BY 1;
      `,
      params,
    );
  }

  async getSuccessTrend(days = 30, userId?: string) {
    const raw = await this.getCallsPerDay(days, userId);
    return raw.map(r => ({
      day: r.day,
      successRate: r.llamadas ? r.exitosas / r.llamadas : 0,
      failureRate: r.llamadas ? 1 - r.exitosas / r.llamadas : 0,
    }));
  }

  /* --------------------------------------------------------- *
   * MÉTRICAS EXTRA
   * --------------------------------------------------------- */
  getCallStatusDistribution(days = 30, userId?: string) {
    const extra = userId ? this.createdBy(2) : '';
    const params: (number | string)[] = [days]; if (userId) params.push(userId);

    return this.contactRepo.query(
      `
      SELECT ct."callStatus"                                   AS status,
             COUNT(*)::INT                                    AS total
      FROM contact ct
      JOIN campaign c ON c.id = ct."campaignId"
      WHERE c."startDate" >= NOW() - ($1 * INTERVAL '1 day')
        ${extra}
      GROUP BY 1
      ORDER BY 2 DESC;
      `,
      params,
    );
  }

  getAttemptsEfficiency(days = 30, userId?: string) {
    const extra = userId ? this.createdBy(2) : '';
    const params: (number | string)[] = [days]; if (userId) params.push(userId);

    return this.contactRepo.query(
      `
      SELECT ct."attemptCount"::INT                            AS attemptcount,
             COUNT(*)::INT                                    AS total,
             COUNT(*) FILTER (WHERE ct."callStatus"='SUCCESS')::INT AS success,
             COUNT(*) FILTER (WHERE ct."callStatus"='FAILED')::INT  AS failure
      FROM contact ct
      JOIN campaign c ON c.id = ct."campaignId"
      WHERE c."startDate" >= NOW() - ($1 * INTERVAL '1 day')
        ${extra}
      GROUP BY 1
      ORDER BY 1;
      `,
      params,
    );
  }

  async getRetryRate(days = 30, userId?: string) {
    const extra = userId ? this.createdBy(2) : '';
    const params: (number | string)[] = [days]; if (userId) params.push(userId);

    const [row] = await this.contactRepo.query(
      `
      SELECT COUNT(*)::INT AS total,
             COUNT(*) FILTER (WHERE ct."attemptCount">1)::INT AS withretry
      FROM contact ct
      JOIN campaign c ON c.id = ct."campaignId"
      WHERE c."startDate" >= NOW() - ($1 * INTERVAL '1 day')
        ${extra};
      `,
      params,
    );
    const { total, withretry } = row;
    return { total, withRetry: withretry, retryRate: total ? withretry / total : 0 };
  }

  /* ---------- nuevas métricas ---------- */
  getFailureTrend(days = 30, userId?: string) {
    const extra = userId ? this.createdBy(2) : '';
    const params: (number | string)[] = [days]; if (userId) params.push(userId);

    return this.contactRepo.query(
      `
      SELECT TO_CHAR(c."startDate",'YYYY-MM-DD')              AS day,
             COUNT(*)::INT                                   AS failed
      FROM contact ct
      JOIN campaign c ON c.id = ct."campaignId"
      WHERE ct."callStatus"='FAILED'
        AND c."startDate" >= NOW() - ($1 * INTERVAL '1 day')
        ${extra}
      GROUP BY 1
      ORDER BY 1;
      `,
      params,
    );
  }

  getSuccessRateByHour(days = 30, userId?: string) {
    const extra = userId ? this.createdBy(2) : '';
    const params: (number | string)[] = [days]; if (userId) params.push(userId);

    return this.contactRepo.query(
      `
      SELECT EXTRACT(HOUR FROM c."startDate")::INT             AS hour,
             ROUND(
               COUNT(*) FILTER (WHERE ct."callStatus"='SUCCESS')::NUMERIC
               / NULLIF(COUNT(*),0),4
             )                                                AS successrate
      FROM contact ct
      JOIN campaign c ON c.id = ct."campaignId"
      WHERE c."startDate" >= NOW() - ($1 * INTERVAL '1 day')
        ${extra}
      GROUP BY 1
      ORDER BY 1;
      `,
      params,
    );
  }

  getTopBusyHours(limit = 5, days = 30, userId?: string) {
    const extra = userId ? this.createdBy(3) : '';
    const params: (number | string)[] = [limit, days]; if (userId) params.push(userId);

    return this.contactRepo.query(
      `
      SELECT EXTRACT(HOUR FROM c."startDate")::INT AS hour,
             COUNT(*)::INT                         AS calls
      FROM contact ct
      JOIN campaign c ON c.id = ct."campaignId"
      WHERE c."startDate" >= NOW() - ($2 * INTERVAL '1 day')
        ${extra}
      GROUP BY 1
      ORDER BY 2 DESC
      LIMIT $1;
      `,
      params,
    );
  }

  async getAvgCallsPerCampaign(days = 30, userId?: string) {
    const extra = userId ? this.createdBy(2) : '';
    const params: (number | string)[] = [days]; if (userId) params.push(userId);

    const [{ avg }] = await this.contactRepo.query(
      `
      SELECT COALESCE(AVG(callcount),0)::NUMERIC(10,2) AS avg
      FROM (
        SELECT COUNT(*)::INT AS callcount
        FROM campaign c
        LEFT JOIN contact ct ON ct."campaignId" = c.id
        WHERE c."startDate" >= NOW() - ($1 * INTERVAL '1 day')
          ${extra}
        GROUP BY c.id
      ) sub;
      `,
      params,
    );
    return { avg: +avg };
  }

  /* ---------- duración campañas activas ---------- */
  async getActiveCampaignDurations(userId?: string) {
    const extra = userId ? `AND "createdBy"::uuid = $1::uuid` : '';
    const params = userId ? [userId] : [];

    const [{ min }] = await this.campRepo.query(
      `SELECT COALESCE(MIN(EXTRACT(EPOCH FROM NOW()-"startDate")/60),0)::INT AS min
       FROM campaign WHERE status='RUNNING' ${extra}`,
      params,
    );
    const [{ avg }] = await this.campRepo.query(
      `SELECT COALESCE(AVG(EXTRACT(EPOCH FROM NOW()-"startDate")/60),0)::INT AS avg
       FROM campaign WHERE status='RUNNING' ${extra}`,
      params,
    );
    const [{ max }] = await this.campRepo.query(
      `SELECT COALESCE(MAX(EXTRACT(EPOCH FROM NOW()-"startDate")/60),0)::INT AS max
       FROM campaign WHERE status='RUNNING' ${extra}`,
      params,
    );
    return { min: +min, avg: +avg, max: +max };
  }

  async getChannelPressure(userId?: string) {
    if (userId) {
      const sql = `
      SELECT
        cl."maxChannels"  AS total,
        COALESCE(SUM(c."concurrentCalls"), 0) AS used,
        CASE
          WHEN cl."maxChannels" = 0 THEN 0
          ELSE COALESCE(SUM(c."concurrentCalls"), 0)::float / cl."maxChannels"
        END AS pressure
      FROM channel_limit cl
      LEFT JOIN campaign c
        ON c."createdBy"::uuid = cl."userId"::uuid
       AND c.status IN ('SCHEDULED','RUNNING','PAUSED')
      WHERE cl."userId" = $1
      GROUP BY cl."maxChannels";
    `;
      const [row] = await this.limitRepo.query(sql, [userId]);
      if (!row) {
        return { total: 0, used: 0, pressure: 0 };
      }
      return {
        total: Number(row.total),
        used: Number(row.used),
        pressure: Number(row.pressure),
      };
    } else {
      const sql = `
      SELECT
        SUM(cl."maxChannels")                  AS total,
        COALESCE(SUM(c."concurrentCalls"), 0)   AS used,
        CASE
          WHEN SUM(cl."maxChannels") = 0 THEN 0
          ELSE COALESCE(SUM(c."concurrentCalls"), 0)::float
               / SUM(cl."maxChannels")
        END AS pressure
      FROM channel_limit cl
      LEFT JOIN campaign c
        ON c."createdBy"::uuid = cl."userId"::uuid
       AND c.status IN ('SCHEDULED','RUNNING','PAUSED');
    `;
      const [row] = await this.limitRepo.query(sql);
      return {
        total: Number(row.total) || 0,
        used: Number(row.used) || 0,
        pressure: Number(row.pressure) || 0,
      };
    }
  }
  async getChannelUsageSnapshot() {
    const sql = `
    SELECT
      cl."userId"    AS "userId",
      u.username     AS username,
      cl."maxChannels"   AS max,
      COALESCE(SUM(c."concurrentCalls"), 0) AS used,
      cl."maxChannels" - COALESCE(SUM(c."concurrentCalls"), 0) AS available
    FROM channel_limit cl
    JOIN "user" u
      ON u.id = cl."userId"::uuid
    LEFT JOIN campaign c
      ON c."createdBy"::uuid = cl."userId"::uuid
     AND c.status IN ('SCHEDULED','RUNNING','PAUSED')
    GROUP BY cl."userId", u.username, cl."maxChannels"
    ORDER BY u.username;
  `;
    return this.limitRepo.query(sql);
  }

  /* --------------------------------------------------------- *
   * RANKINGS & OVERVIEW
   * --------------------------------------------------------- */
  getAgentPerformance(days = 30, userId?: string) {
    const userFilter = userId ? `WHERE u.id = $2::uuid` : '';
    const params: (number | string)[] = [days]; if (userId) params.push(userId);

    return this.contactRepo.query(
      `
      SELECT u.id                                             AS userid,
             u.username,
             COUNT(ct.id)::INT                                AS totalcalls,
             COUNT(ct.id) FILTER (WHERE ct."callStatus"='SUCCESS')::INT AS successfulcalls,
             ROUND(
               CASE WHEN COUNT(ct.id)=0 THEN 0
                    ELSE COUNT(ct.id) FILTER (WHERE ct."callStatus"='SUCCESS')::NUMERIC/COUNT(ct.id)
               END,4)                                         AS successrate
      FROM "user" u
      LEFT JOIN campaign c ON c."createdBy"::uuid = u.id
        AND c."startDate" >= NOW() - ($1 * INTERVAL '1 day')
      LEFT JOIN contact ct ON ct."campaignId" = c.id
      ${userFilter}
      GROUP BY u.id, u.username
      ORDER BY successrate DESC, totalcalls DESC;
      `,
      params,
    );
  }

  getTopHangupCauses(limit = 5, days = 30, userId?: string) {
    const extra = userId ? this.createdBy(3) : '';
    const params: (number | string)[] = [limit, days]; if (userId) params.push(userId);

    return this.contactRepo.query(
      `
      SELECT COALESCE(ct."hangupCause",'Desconocida')          AS cause,
             COUNT(*)::INT                                    AS total
      FROM contact ct
      JOIN campaign c ON c.id = ct."campaignId"
      WHERE c."startDate" >= NOW() - ($2 * INTERVAL '1 day')
        ${extra}
      GROUP BY 1
      ORDER BY 2 DESC
      LIMIT $1;
      `,
      params,
    );
  }

  getCampaignLeaderboard(limit = 5, userId?: string) {
    const where = userId ? `WHERE c."createdBy"::uuid = $2::uuid` : '';
    const params: (number | string)[] = [limit];
    if (userId) params.push(userId);

    return this.contactRepo.query(
      `
      SELECT c.id,
             c.name,
             COUNT(ct.id)::INT                                 AS total,
             COUNT(ct.id) FILTER (WHERE ct."callStatus"='SUCCESS')::INT AS ok,
             ROUND(
               CASE WHEN COUNT(ct.id)=0 THEN 0
                    ELSE COUNT(ct.id) FILTER (WHERE ct."callStatus"='SUCCESS')::NUMERIC/COUNT(ct.id)
               END,4)                                          AS successrate
      FROM campaign c
      LEFT JOIN contact ct ON ct."campaignId" = c.id
      ${where}
      GROUP BY c.id, c.name
      ORDER BY successrate DESC, total DESC
      LIMIT $1;
      `,
      params,
    );
  }

  /* ---------- overview ---------- */
  async getOverview(userId?: string) {
    const extra = userId ? `WHERE c."createdBy"::uuid = $1::uuid` : '';
    const params = userId ? [userId] : [];

    const [{ active }] = await this.campRepo.query(
      `SELECT COUNT(*)::INT AS active FROM campaign c WHERE c.status IN('RUNNING','PAUSED') ${extra}`,
      params,
    );
    const [{ calling }] = await this.contactRepo.query(
      `
      SELECT COUNT(*)::INT AS calling
      FROM contact ct
      JOIN campaign c ON c.id = ct."campaignId"
      WHERE ct."callStatus"='CALLING' ${extra.replace('c.', 'c.')};
      `,
      params,
    );
    const [{ sr }] = await this.contactRepo.query(
      `
      SELECT CASE WHEN COUNT(*)=0 THEN 0
                  ELSE COUNT(*) FILTER (WHERE ct."callStatus"='SUCCESS')::NUMERIC/COUNT(*)
             END AS sr
      FROM contact ct
      JOIN campaign c ON c.id = ct."campaignId"
      WHERE 1=1 ${extra.replace('c.', 'c.')};
      `,
      params,
    );

    if (userId) {
      const [lim] = await this.limitRepo.query(
        `SELECT "maxChannels"::INT AS max,"usedChannels"::INT AS used FROM channel_limit WHERE "userId"::text = $1`,
        [userId],
      );
      return {
        activeCampaigns: +active,
        ongoingCalls: +calling,
        successRate: +sr,
        channels: {
          total: lim?.max ?? 0,
          used: lim?.used ?? 0,
          available: Math.max(0, (lim?.max ?? 0) - (lim?.used ?? 0)),
        },
      };
    }

    const [{ totalmax }] = await this.limitRepo.query(
      `SELECT SUM("maxChannels")::INT AS totalmax FROM channel_limit`);
    const [{ totalused }] = await this.limitRepo.query(
      `SELECT SUM("usedChannels")::INT AS totalused FROM channel_limit`);

    return {
      activeCampaigns: +active,
      ongoingCalls: +calling,
      successRate: +sr,
      channels: {
        total: +totalmax || 0,
        used: +totalused || 0,
        available: Math.max(0, (+totalmax || 0) - (+totalused || 0)),
      },
    };
  }
  
  /* =====================================================================
        RESUMEN DE CAMPAÑAS – utilizado por la tabla y el Excel
     ===================================================================== */
  async getCampaignSummary(
    start: string,
    end: string,
    userId?: string,
  ) {
    const params: string[] = [start, end];
    const filter = userId ? this.createdByTxt(3) : '';
    if (userId) params.push(userId);

    return this.contactRepo.query(
      `
        SELECT
          c.id,
          c.name,
          c.status,
          TO_CHAR(c."startDate", 'YYYY-MM-DD') AS start,
          TO_CHAR(c."endDate", 'YYYY-MM-DD') AS "end",
          ROUND(EXTRACT(EPOCH FROM (c."endDate" - c."startDate"))/3600,2) AS hours,
          COALESCE(u.username,'-') AS created_by,
          COUNT(ct.id)::INT AS total,
          COUNT(*) FILTER (WHERE ct."callStatus"='SUCCESS')::INT AS success,
          COUNT(*) FILTER (WHERE ct."callStatus"='FAILED')::INT AS failed,
          COUNT(*) FILTER (
              WHERE ct."callStatus" NOT IN ('SUCCESS','FAILED')
          )::INT AS pending,
          SUM(ct."attemptCount")::INT AS attempts,
          ROUND(AVG(ct."attemptCount")::NUMERIC,2) AS avg_attempts,
          COUNT(*) FILTER (WHERE ct."attemptCount" > 1)::INT AS with_retry,
          ROUND(
            CASE WHEN COUNT(*) = 0 THEN 0
                 ELSE COUNT(*) FILTER (WHERE ct."callStatus"='SUCCESS')::NUMERIC / COUNT(*)
            END, 4
          ) AS success_rate
        FROM campaign c
        LEFT JOIN contact ct ON ct."campaignId" = c.id
        LEFT JOIN "user" u ON u.id = c."createdBy"::uuid
        WHERE c."startDate"::date >= $1::date
          AND c."startDate"::date <= $2::date
          ${filter}
        GROUP BY c.id, u.username
        ORDER BY c."startDate";
        `,
      params,
    );
  }

  /* =====================================================================
        EXCEL premium – se nutre de getCampaignSummary()
     ===================================================================== */
  async generateCampaignReport(
    start: string,
    end: string,
    userId?: string,
  ) {
    const data = await this.getCampaignSummary(start, end, userId);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Campañas');

    ws.columns = [
      { header: '#', key: 'idx', width: 4 },
      { header: 'Campaña', key: 'name', width: 30 },
      { header: 'Estado', key: 'status', width: 12 },
      { header: 'Inicio', key: 'start', width: 12 },
      { header: 'Fin', key: 'end', width: 12 },
      { header: 'Duración (h)', key: 'hours', width: 14 },
      { header: 'Creador', key: 'created_by', width: 18 },
      { header: 'Contactos', key: 'total', width: 12 },
      { header: 'Éxitos', key: 'success', width: 10 },
      { header: 'Fallidos', key: 'failed', width: 10 },
      { header: 'Pendientes', key: 'pending', width: 12 },
      { header: 'Éxito %', key: 'success_rate', width: 10 },
      { header: 'Intentos tot.', key: 'attempts', width: 14 },
      { header: 'Prom. intentos', key: 'avg_attempts', width: 14 },
      { header: 'Con reintento', key: 'with_retry', width: 14 },
    ];

    data.forEach((row, i) => ws.addRow({ idx: i + 1, ...row }));

    ['L'].forEach(col => {
      ws.getColumn(col).numFmt = '0.00%';
    });
    ws.getRow(1).font = { bold: true };
    ws.autoFilter = { from: 'A1', to: 'O1' };

    return wb.xlsx.writeBuffer();
  }

  /**
   * ✅ NUEVO: Obtiene un resumen agregado de las campañas de WhatsApp.
   */
  async getWhatsappStats(userId?: string) {
    const campaignQuery = this.whatsappCampRepo.createQueryBuilder('campaign');
    if (userId) {
      campaignQuery.where('campaign."createdBy" = :userId', { userId });
    }
    
    const activeCampaigns = await campaignQuery.clone().andWhere("campaign.status IN ('RUNNING', 'PAUSED')").getCount();
    
    const statsQuery = this.whatsappContactRepo.createQueryBuilder('contact')
      .select('contact.status', 'status')
      .addSelect('COUNT(*)::int', 'count')
      .innerJoin('contact.campaign', 'campaign');

    if (userId) {
      statsQuery.where('campaign."createdBy" = :userId', { userId });
    }
    
    const stats = await statsQuery.groupBy('contact.status').getRawMany();

    const statsMap = stats.reduce((acc, item) => {
        acc[item.status.toLowerCase()] = item.count;
        return acc;
    }, { sent: 0, pending: 0, failed: 0, sending: 0, delivered: 0, read: 0 });

    return {
        activeCampaigns,
        ...statsMap
    };
  }

  /**
   * ✅ MEJORADO: Devuelve un objeto completo con estadísticas de IVR y WhatsApp, AHORA CON TENDENCIAS.
   */
  async getDashboardOverview(userId?: string) {
    const periodDays = 30;
    const [currentMetrics, previousMetrics, whatsappOverview] = await Promise.all([
      this.getIvrMetricsForPeriod(periodDays, 0, userId),
      this.getIvrMetricsForPeriod(periodDays, periodDays, userId),
      this.getWhatsappStats(userId)
    ]);
  
    const calculateChange = (current, previous) => {
      if (previous === 0) return current > 0 ? Infinity : 0;
      return ((current - previous) / previous) * 100;
    };
  
    // Obtenemos los datos de canales por separado, ya que no dependen del período.
    const overviewData = await this.getOverview(userId);
  
    const ivrOverview = {
      activeCampaigns: {
        value: currentMetrics.activeCampaigns,
        change: calculateChange(currentMetrics.activeCampaigns, previousMetrics.activeCampaigns),
      },
      ongoingCalls: {
        value: currentMetrics.ongoingCalls,
        change: 0, // No se calcula tendencia para un valor en tiempo real
      },
      successRate: {
        value: currentMetrics.successRate,
        // La diferencia de tasas de éxito se calcula como puntos porcentuales
        change: (currentMetrics.successRate - previousMetrics.successRate) * 100, 
      },
      channels: overviewData.channels,
    };
  
    return {
      ivr: ivrOverview,
      whatsapp: whatsappOverview,
    };
  }
  

  /**
   * ✅ NUEVO: Analiza el rendimiento de los agentes y predice el mejor.
   */
  async getAgentLeaderboard(days = 30) {
    const performanceData = await this.getAgentPerformance(days);

    if (performanceData.length === 0) {
      return {
        leaderboard: [],
        topPerformer: null,
        averageCalls: 0,
        averageSuccessRate: 0
      };
    }

    const topPerformer = {
        ...performanceData[0],
        prediction: `Basado en su tasa de éxito del ${(performanceData[0].successrate * 100).toFixed(1)}%, ${performanceData[0].username} es el agente más efectivo.`
    };
    
    const totalAgents = performanceData.length;
    const totalCalls = performanceData.reduce((sum, agent) => sum + agent.totalcalls, 0);
    const totalSuccessRate = performanceData.reduce((sum, agent) => sum + parseFloat(agent.successrate), 0);
    
    const averageCalls = totalCalls / totalAgents;
    const averageSuccessRate = totalSuccessRate / totalAgents;

    return {
      leaderboard: performanceData,
      topPerformer,
      averageCalls: averageCalls.toFixed(2),
      averageSuccessRate: (averageSuccessRate * 100).toFixed(2)
    };
  }
}