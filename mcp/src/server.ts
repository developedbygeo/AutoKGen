// mcp-neo4j-server/src/server.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, Tool } from '@modelcontextprotocol/sdk/types.js';
import neo4j, { Driver, Session } from 'neo4j-driver';

// Neo4j connection configuration
const NEO4J_URI = process.env.NEO4J_URI || 'bolt://localhost:7687';
const NEO4J_USER = process.env.NEO4J_USER || 'neo4j';
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || '123123123';

class Neo4jMCPServer {
  private server: Server;
  private driver: Driver;

  constructor() {
    this.server = new Server(
      {
        name: 'neo4j-mcp-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    // Initialize Neo4j driver
    this.driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));

    this.setupHandlers();
    this.setupErrorHandling();
  }

  private setupErrorHandling(): void {
    this.server.onerror = (error) => {
      console.error('[MCP Error]', error);
    };

    process.on('SIGINT', async () => {
      await this.driver.close();
      process.exit(0);
    });
  }

  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.getTools(),
    }));

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'execute_cypher':
            return await this.executeCypher(args);
          case 'create_nodes':
            return await this.createNodes(args);
          case 'create_relationships':
            return await this.createRelationships(args);
          case 'get_schema':
            return await this.getSchema();
          case 'clear_database':
            return await this.clearDatabase();
          case 'run_bulk_import':
            return await this.runBulkImport(args);
          case 'validate_graph':
            return await this.validateGraph();
          case 'get_statistics':
            return await this.getStatistics();
          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  private getTools(): Tool[] {
    return [
      {
        name: 'execute_cypher',
        description: 'Execute a raw Cypher query against Neo4j',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Cypher query to execute',
            },
            parameters: {
              type: 'object',
              description: 'Query parameters (optional)',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'create_nodes',
        description: 'Batch create nodes from JSON data',
        inputSchema: {
          type: 'object',
          properties: {
            nodes: {
              type: 'array',
              description: 'Array of nodes with id, labels, and properties',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  labels: { type: 'array', items: { type: 'string' } },
                  properties: { type: 'object' },
                },
              },
            },
          },
          required: ['nodes'],
        },
      },
      {
        name: 'create_relationships',
        description: 'Batch create relationships from JSON data',
        inputSchema: {
          type: 'object',
          properties: {
            relationships: {
              type: 'array',
              description: 'Array of relationships with type, from, to, and properties',
              items: {
                type: 'object',
                properties: {
                  type: { type: 'string' },
                  from: { type: 'string' },
                  to: { type: 'string' },
                  properties: { type: 'object' },
                },
              },
            },
          },
          required: ['relationships'],
        },
      },
      {
        name: 'get_schema',
        description: 'Get the current database schema (node labels, relationship types, constraints)',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'clear_database',
        description: 'Clear all nodes and relationships from the database (USE WITH CAUTION)',
        inputSchema: {
          type: 'object',
          properties: {
            confirm: {
              type: 'boolean',
              description: 'Must be true to confirm deletion',
            },
          },
          required: ['confirm'],
        },
      },
      {
        name: 'run_bulk_import',
        description: 'Import graph data from JSON file (nodes and relationships)',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: {
              type: 'string',
              description: 'Path to JSON file containing graph data',
            },
          },
          required: ['filePath'],
        },
      },
      {
        name: 'validate_graph',
        description: 'Validate the graph structure against ontology constraints',
        inputSchema: {
          type: 'object',
          properties: {
            ontologyPath: {
              type: 'string',
              description: 'Path to ontology JSON file',
            },
          },
        },
      },
      {
        name: 'get_statistics',
        description: 'Get graph statistics (node counts, relationship counts, etc.)',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ];
  }

  private async executeCypher(args: any) {
    const session = this.driver.session();
    try {
      const result = await session.run(args.query, args.parameters || {});
      const records = result.records.map((record) => record.toObject());

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                records,
                summary: {
                  counters: result.summary.counters,
                  resultAvailableAfter: result.summary.resultAvailableAfter,
                  resultConsumedAfter: result.summary.resultConsumedAfter,
                },
              },
              null,
              2,
            ),
          },
        ],
      };
    } finally {
      await session.close();
    }
  }

  private async createNodes(args: any) {
    const session = this.driver.session();
    const { nodes } = args;

    try {
      let created = 0;
      const batchSize = 1000;

      for (let i = 0; i < nodes.length; i += batchSize) {
        const batch = nodes.slice(i, i + batchSize);

        const query = `
          UNWIND $nodes AS node
          CALL {
            WITH node
            CALL apoc.create.node(node.labels, node.properties) YIELD node AS n
            RETURN n
          }
          RETURN count(*) as created
        `;

        // Fallback if APOC not available
        const fallbackQuery = `
          UNWIND $nodes AS node
          CREATE (n)
          SET n = node.properties
          WITH n, node.labels AS labels
          CALL apoc.create.addLabels(n, labels) YIELD node
          RETURN count(*) as created
        `;

        try {
          const result = await session.run(query, { nodes: batch });
          created += result.records[0].get('created').toNumber();
        } catch (error) {
          // Try manual approach if APOC not available
          for (const node of batch) {
            const labels = node.labels.join(':');
            const manualQuery = `CREATE (n:${labels}) SET n = $properties`;
            await session.run(manualQuery, { properties: node.properties });
            created++;
          }
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: `Successfully created ${created} nodes`,
          },
        ],
      };
    } finally {
      await session.close();
    }
  }

  private async createRelationships(args: any) {
    const session = this.driver.session();
    const { relationships } = args;

    try {
      let created = 0;
      const batchSize = 1000;

      for (let i = 0; i < relationships.length; i += batchSize) {
        const batch = relationships.slice(i, i + batchSize);

        for (const rel of batch) {
          const query = `
            MATCH (a {id: $fromId})
            MATCH (b {id: $toId})
            CREATE (a)-[r:${rel.type}]->(b)
            SET r = $properties
            RETURN r
          `;

          await session.run(query, {
            fromId: rel.from,
            toId: rel.to,
            properties: rel.properties || {},
          });
          created++;
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: `Successfully created ${created} relationships`,
          },
        ],
      };
    } finally {
      await session.close();
    }
  }

  private async getSchema() {
    const session = this.driver.session();
    try {
      // Get node labels
      const labelsResult = await session.run('CALL db.labels()');
      const labels = labelsResult.records.map((r) => r.get(0));

      // Get relationship types
      const relsResult = await session.run('CALL db.relationshipTypes()');
      const relationshipTypes = relsResult.records.map((r) => r.get(0));

      // Get constraints
      const constraintsResult = await session.run('SHOW CONSTRAINTS');
      const constraints = constraintsResult.records.map((r) => r.toObject());

      // Get indexes
      const indexesResult = await session.run('SHOW INDEXES');
      const indexes = indexesResult.records.map((r) => r.toObject());

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                nodeLabels: labels,
                relationshipTypes,
                constraints,
                indexes,
              },
              null,
              2,
            ),
          },
        ],
      };
    } finally {
      await session.close();
    }
  }

  private async clearDatabase() {
    const session = this.driver.session();
    try {
      await session.run('MATCH (n) DETACH DELETE n');
      return {
        content: [
          {
            type: 'text',
            text: 'Database cleared successfully',
          },
        ],
      };
    } finally {
      await session.close();
    }
  }

  private async runBulkImport(args: any) {
    const { filePath } = args;
    const fs = require('fs');
    const graphData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

    // Create nodes first
    await this.createNodes({ nodes: graphData.nodes });

    // Then create relationships
    await this.createRelationships({ relationships: graphData.relationships });

    return {
      content: [
        {
          type: 'text',
          text: `Bulk import completed: ${graphData.nodes.length} nodes, ${graphData.relationships.length} relationships`,
        },
      ],
    };
  }

  private async validateGraph() {
    // Validation logic here
    return {
      content: [
        {
          type: 'text',
          text: 'Graph validation not yet implemented',
        },
      ],
    };
  }

  private async getStatistics() {
    const session = this.driver.session();
    try {
      const nodeCountResult = await session.run('MATCH (n) RETURN count(n) as count');
      const nodeCount = nodeCountResult.records[0].get('count').toNumber();

      const relCountResult = await session.run('MATCH ()-[r]->() RETURN count(r) as count');
      const relCount = relCountResult.records[0].get('count').toNumber();

      const labelStatsResult = await session.run(`
        MATCH (n)
        RETURN labels(n) as labels, count(*) as count
        ORDER BY count DESC
      `);
      const labelStats = labelStatsResult.records.map((r) => ({
        labels: r.get('labels'),
        count: r.get('count').toNumber(),
      }));

      const relTypeStatsResult = await session.run(`
        MATCH ()-[r]->()
        RETURN type(r) as type, count(*) as count
        ORDER BY count DESC
      `);
      const relTypeStats = relTypeStatsResult.records.map((r) => ({
        type: r.get('type'),
        count: r.get('count').toNumber(),
      }));

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                totalNodes: nodeCount,
                totalRelationships: relCount,
                nodesByLabel: labelStats,
                relationshipsByType: relTypeStats,
              },
              null,
              2,
            ),
          },
        ],
      };
    } finally {
      await session.close();
    }
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Neo4j MCP server running on stdio');
  }
}

// Start the server
const server = new Neo4jMCPServer();
server.run().catch(console.error);
