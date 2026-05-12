export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      admin_config: {
        Row: {
          ai_magic_system: string
          atualizado_em: string
          id: number
          openrouter_api_key: string
          openrouter_model: string
        }
        Insert: {
          ai_magic_system?: string
          atualizado_em?: string
          id?: number
          openrouter_api_key?: string
          openrouter_model?: string
        }
        Update: {
          ai_magic_system?: string
          atualizado_em?: string
          id?: number
          openrouter_api_key?: string
          openrouter_model?: string
        }
        Relationships: []
      }
      clientes: {
        Row: {
          atualizado_em: string
          criado_em: string
          db_host: string | null
          db_name: string | null
          db_pass: string | null
          db_port: number | null
          db_schema_prefix: string | null
          db_type: Database["public"]["Enums"]["database_type"]
          db_user: string | null
          id: string
          id_conta_database: string | null
          id_conta_helena: string
          nome: string
          nome_agente: string | null
          supabase_key: string | null
          supabase_url: string | null
        }
        Insert: {
          atualizado_em?: string
          criado_em?: string
          db_host?: string | null
          db_name?: string | null
          db_pass?: string | null
          db_port?: number | null
          db_schema_prefix?: string | null
          db_type?: Database["public"]["Enums"]["database_type"]
          db_user?: string | null
          id?: string
          id_conta_database?: string | null
          id_conta_helena: string
          nome: string
          nome_agente?: string | null
          supabase_key?: string | null
          supabase_url?: string | null
        }
        Update: {
          atualizado_em?: string
          criado_em?: string
          db_host?: string | null
          db_name?: string | null
          db_pass?: string | null
          db_port?: number | null
          db_schema_prefix?: string | null
          db_type?: Database["public"]["Enums"]["database_type"]
          db_user?: string | null
          id?: string
          id_conta_database?: string | null
          id_conta_helena?: string
          nome?: string
          nome_agente?: string | null
          supabase_key?: string | null
          supabase_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "clientes_id_conta_database_fkey"
            columns: ["id_conta_database"]
            isOneToOne: false
            referencedRelation: "contas_database"
            referencedColumns: ["id"]
          },
        ]
      }
      contas_database: {
        Row: {
          atualizado_em: string
          criado_em: string
          db_host: string
          db_name: string
          db_pass: string
          db_port: number
          db_user: string
          id: string
          nome: string
        }
        Insert: {
          atualizado_em?: string
          criado_em?: string
          db_host: string
          db_name: string
          db_pass: string
          db_port?: number
          db_user: string
          id?: string
          nome: string
        }
        Update: {
          atualizado_em?: string
          criado_em?: string
          db_host?: string
          db_name?: string
          db_pass?: string
          db_port?: number
          db_user?: string
          id?: string
          nome?: string
        }
        Relationships: []
      }
      prompt_history: {
        Row: {
          chars: number
          cliente_id: string
          criado_em: string
          id: string
          prompt: string
          resumo: string
        }
        Insert: {
          chars?: number
          cliente_id: string
          criado_em?: string
          id?: string
          prompt?: string
          resumo?: string
        }
        Update: {
          chars?: number
          cliente_id?: string
          criado_em?: string
          id?: string
          prompt?: string
          resumo?: string
        }
        Relationships: [
          {
            foreignKeyName: "prompt_history_cliente_id_fkey"
            columns: ["cliente_id"]
            isOneToOne: false
            referencedRelation: "clientes"
            referencedColumns: ["id"]
          },
        ]
      }
      prompt_templates: {
        Row: {
          atualizado_em: string
          conteudo: string
          criado_em: string
          descricao: string | null
          id: string
          nome: string
        }
        Insert: {
          atualizado_em?: string
          conteudo?: string
          criado_em?: string
          descricao?: string | null
          id?: string
          nome: string
        }
        Update: {
          atualizado_em?: string
          conteudo?: string
          criado_em?: string
          descricao?: string | null
          id?: string
          nome?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      database_type: "supabase" | "postgres"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      database_type: ["supabase", "postgres"],
    },
  },
} as const
